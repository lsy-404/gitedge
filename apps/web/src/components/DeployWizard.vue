<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DeployPlan, DeployResult } from "../../../../packages/contracts/src/deploy";
import { ApiError, api, errorMessage, type DeployAccount, type Repository } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import StatusBadge from "./StatusBadge.vue";

type DeployStepId = "provision" | "migrate" | "deploy";
type Progress = { id: DeployStepId; state: "pending" | "running" | "done" | "failed" };

const props = defineProps<{ repository: Repository }>();
const { t } = useI18n();
const refName = ref(props.repository.defaultBranch || "HEAD");
const plan = ref<DeployPlan | null>(null);
const token = ref("");
const accounts = ref<DeployAccount[]>([]);
const accountId = ref("");
const accountConfirmed = ref(false);
const sessionNonce = ref("");
const resourceNames = ref<Record<string, string>>({});
const resourceCheckFailed = ref(false);
const resourceAvailability = ref<Record<string, boolean>>({});
const workerName = ref("");
const accepted = ref(false);
const loading = ref(false);
const error = ref("");
const progress = ref<Progress[]>([]);
const result = ref<DeployResult | null>(null);
const step = ref<"read" | "authorize" | "review" | "result">("read");

onBeforeUnmount(() => {
  void api.endDeploySession(props.repository.id, refName.value).catch(() => undefined);
});

function failureMessage(cause: unknown): string {
  const fallback = errorMessage(cause, t, {}, "deployWizard.error");
  return cause instanceof ApiError && cause.code !== null && cause.message
    ? t("deployWizard.errorDetail", { message: fallback, detail: cause.message })
    : fallback;
}

async function readPlan() {
  loading.value = true;
  error.value = "";
  plan.value = null;
  try {
    plan.value = await api.deployPlan(props.repository.id, refName.value);
    workerName.value = plan.value.manifest.worker.name || `${props.repository.name}-worker`;
    resourceNames.value = Object.fromEntries(
      [
        ...plan.value.manifest.resources.d1,
        ...plan.value.manifest.resources.r2,
        ...plan.value.manifest.resources.kv,
      ].map((item) => [item.id, item.name])
    );
    step.value = "authorize";
  } catch (cause) {
    error.value = failureMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function startSession() {
  if (!plan.value || !token.value) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await api.deploySession(props.repository.id, refName.value, {
      token: token.value,
      manifestDigest: plan.value.manifestDigest,
    });
    sessionNonce.value = data.nonce;
    token.value = "";
    accounts.value = data.accounts;
    if (accounts.value.length === 1) {
      accountId.value = accounts.value[0].id;
      await chooseAccount();
    } else step.value = "review";
  } catch (cause) {
    token.value = "";
    error.value = failureMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function chooseAccount() {
  if (!plan.value || !accountId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await api.deployAccount(props.repository.id, refName.value, {
      accountId: accountId.value,
      nonce: sessionNonce.value,
    });
    accountConfirmed.value = true;
    step.value = "review";
    await loadResources();
  } catch (cause) {
    error.value = failureMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function loadResources() {
  resourceCheckFailed.value = false;
  try {
    const data = await api.deployResources(props.repository.id, refName.value, {
      nonce: sessionNonce.value,
      resourceNames: resourceNames.value,
    });
    resourceAvailability.value = Object.fromEntries(
      data.resources.map((item) => [item.id, item.exists])
    );
  } catch {
    resourceCheckFailed.value = true;
  }
}

async function runStep<T>(id: DeployStepId): Promise<T | null> {
  let progressStep = progress.value.find((item) => item.id === id);
  if (!progressStep) {
    progressStep = { id, state: "pending" };
    progress.value.push(progressStep);
  }
  progressStep.state = "running";
  try {
    const body =
      id === "deploy"
        ? {
            workerName: workerName.value,
            confirmDigest: plan.value?.manifestDigest,
            nonce: sessionNonce.value,
          }
        : { nonce: sessionNonce.value, resourceNames: resourceNames.value };
    const data = await api.deployStep<T>(id, props.repository.id, refName.value, body);
    progressStep.state = "done";
    return data;
  } catch (cause) {
    progressStep.state = "failed";
    error.value = failureMessage(cause);
    return null;
  }
}

const deploymentSteps = computed<DeployStepId[]>(() => {
  if (!plan.value) return [];
  return [
    "provision",
    ...(plan.value.manifest.resources.d1.some((item) => item.migrations.length)
      ? ["migrate" as const]
      : []),
    "deploy",
  ];
});

function stepLabel(id: DeployStepId): string {
  return t(`deployWizard.steps.${id}`);
}

async function runDeploymentSteps(fromIndex = 0) {
  for (const id of deploymentSteps.value.slice(fromIndex)) {
    if (progress.value.find((item) => item.id === id)?.state === "done") continue;
    if (id === "deploy") {
      const deployed = await runStep<DeployResult>(id);
      if (!deployed) return;
      result.value = deployed;
      step.value = "result";
    } else if ((await runStep<Record<string, never>>(id)) === null) return;
  }
}

async function deploy() {
  if (!plan.value || !accepted.value) {
    error.value = t("deployWizard.accept");
    return;
  }
  loading.value = true;
  error.value = "";
  progress.value = [];
  try {
    await runDeploymentSteps();
  } finally {
    loading.value = false;
  }
}

async function retry() {
  if (!plan.value) return;
  const failedId = deploymentSteps.value.find(
    (id) => progress.value.find((item) => item.id === id)?.state === "failed"
  );
  const failedIndex = failedId ? deploymentSteps.value.indexOf(failedId) : -1;
  if (failedIndex < 0) return;
  loading.value = true;
  error.value = "";
  try {
    await runDeploymentSteps(failedIndex);
  } finally {
    loading.value = false;
  }
}

const resourceList = computed(() =>
  plan.value
    ? [
        ...plan.value.manifest.resources.d1.map((item) => ({ ...item, kind: "D1" })),
        ...plan.value.manifest.resources.r2.map((item) => ({ ...item, kind: "R2" })),
        ...plan.value.manifest.resources.kv.map((item) => ({ ...item, kind: "KV" })),
      ]
    : []
);
const migrationPaths = computed(
  () => plan.value?.manifest.resources.d1.flatMap((item) => item.migrations) ?? []
);
</script>

<template>
  <section class="box box-form deploy-wizard" :aria-labelledby="`deploy-title-${repository.id}`">
    <header>
      <div>
        <p class="eyebrow">{{ repository.owner }} / {{ repository.name }}</p>
        <h2 :id="`deploy-title-${repository.id}`">{{ t("deployWizard.title") }}</h2>
        <p class="muted">{{ t("deployWizard.intro") }}</p>
      </div>
    </header>
    <form v-if="step === 'read'" class="deploy-read-form" @submit.prevent="readPlan">
      <TextField
        id="deploy-ref"
        v-model="refName"
        required
        maxlength="255"
        :placeholder="t('deployWizard.chooseRef')"
        >{{ t("deployWizard.ref") }}</TextField
      >
      <FluentButton type="submit" tone="primary" :disabled="loading">
        {{ loading ? "…" : t("deployWizard.load") }}
      </FluentButton>
    </form>
    <div v-else-if="plan && (step === 'authorize' || step === 'review')" class="deploy-review">
      <h3>{{ t("deployWizard.review") }} · {{ plan.manifest.name }}</h3>
      <dl class="deploy-digest">
        <dt>{{ t("deployWizard.source") }}</dt>
        <dd>{{ plan.ref }}</dd>
        <dt>{{ t("deployWizard.manifestDigest") }}</dt>
        <dd>
          <code>{{ plan.manifestDigest }}</code>
        </dd>
        <dt>{{ t("deployWizard.compatibilityDate") }}</dt>
        <dd>{{ plan.manifest.worker.compatibilityDate }}</dd>
      </dl>
      <h4>{{ t("deployWizard.permissions") }}</h4>
      <ul class="deploy-list">
        <li v-for="permission in plan.permissions" :key="permission">{{ permission }}</li>
      </ul>
      <h4>{{ t("deployWizard.modules") }}</h4>
      <ul class="deploy-list">
        <li v-for="module in plan.manifest.worker.modules" :key="module">{{ module }}</li>
        <li>{{ plan.manifest.worker.entrypoint }} · {{ t("deployWizard.entrypoint") }}</li>
      </ul>
      <h4>{{ t("deployWizard.resources") }}</h4>
      <ul v-if="resourceList.length" class="deploy-list">
        <li v-for="resource in resourceList" :key="resource.id">
          {{ resource.kind }} · {{ resource.binding }} · {{ resource.name }}
        </li>
      </ul>
      <p v-else class="muted">{{ t("deployWizard.noResources") }}</p>
      <h4 v-if="migrationPaths.length">{{ t("deployWizard.migrations") }}</h4>
      <ul v-if="migrationPaths.length" class="deploy-list">
        <li v-for="migration in migrationPaths" :key="migration">{{ migration }}</li>
      </ul>
      <h4 v-if="Object.keys(plan.manifest.worker.vars).length">
        {{ t("deployWizard.variables") }}
      </h4>
      <ul v-if="Object.keys(plan.manifest.worker.vars).length" class="deploy-list">
        <li v-for="(value, key) in plan.manifest.worker.vars" :key="key">
          {{ key }} = {{ value }}
        </li>
      </ul>
      <details class="deploy-disclosure">
        <summary>{{ t("deployWizard.license") }} · {{ plan.manifest.license.id }}</summary>
        <pre class="deploy-disclosure-text">{{ plan.manifest.license.text }}</pre>
      </details>
      <details v-if="plan.manifest.terms.text" class="deploy-disclosure">
        <summary>
          {{ t("deployWizard.terms")
          }}<span v-if="plan.manifest.terms.required"> · {{ t("deployWizard.required") }}</span>
        </summary>
        <pre class="deploy-disclosure-text">{{ plan.manifest.terms.text }}</pre>
      </details>
      <form v-if="step === 'authorize'" class="deploy-token-form" @submit.prevent="startSession">
        <TextField id="deploy-token" v-model="token" type="password" autocomplete="off" required>{{
          t("deployWizard.token")
        }}</TextField>
        <p class="muted">{{ t("deployWizard.tokenHint") }}</p>
        <FluentButton type="submit" tone="primary" :disabled="loading">
          {{ t("deployWizard.createSession") }}
        </FluentButton>
      </form>
      <template v-else>
        <div v-if="accounts.length > 1" class="deploy-field">
          <SelectField
            v-model="accountId"
            :label="t('deployWizard.account')"
            @update:model-value="accountConfirmed = false"
          >
            <option value="" disabled>{{ t("deployWizard.chooseAccount") }}</option>
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.name }}
            </option>
          </SelectField>
          <FluentButton type="button" :disabled="loading" @click="chooseAccount">
            {{ t("deployWizard.chooseAccount") }}
          </FluentButton>
        </div>
        <p v-else-if="accounts.length === 1" class="deploy-account">
          <strong>{{ t("deployWizard.account") }}:</strong> {{ accounts[0].name }}
        </p>
        <div v-if="accountConfirmed" class="deploy-resource-controls">
          <div v-for="resource in resourceList" :key="resource.id" class="deploy-resource">
            <TextField
              :id="`deploy-resource-${resource.id}`"
              v-model="resourceNames[resource.id]"
              required
              minlength="3"
              maxlength="48"
              pattern="[a-z][a-z0-9-]*"
              @change="loadResources"
              >{{ resource.kind }} · {{ resource.binding }}</TextField
            >
            <StatusBadge v-if="resourceCheckFailed" tone="neutral">{{
              t("deployWizard.availabilityUnknown")
            }}</StatusBadge>
            <StatusBadge v-else :tone="resourceAvailability[resource.id] ? 'warning' : 'success'">{{
              resourceAvailability[resource.id]
                ? t("deployWizard.existing")
                : t("deployWizard.createNew")
            }}</StatusBadge>
          </div>
          <TextField id="deploy-worker-name" v-model="workerName" required maxlength="58">{{
            t("deployWizard.workerName")
          }}</TextField>
        </div>
        <form class="deploy-confirm-form" @submit.prevent="deploy">
          <FluentCheckbox id="deploy-confirm" v-model="accepted">
            {{ t("deployWizard.confirm") }}
          </FluentCheckbox>
          <FluentButton
            type="submit"
            tone="primary"
            :disabled="loading || !accepted || (accounts.length > 1 && !accountConfirmed)"
          >
            {{ t("deployWizard.deploy") }}
          </FluentButton>
        </form>
      </template>
    </div>
    <div v-if="progress.length" class="deploy-progress" aria-live="polite" aria-atomic="false">
      <h3>{{ t("deployWizard.progress") }}</h3>
      <ol>
        <li v-for="item in progress" :key="item.id" :data-state="item.state">
          <span aria-hidden="true">{{
            item.state === "done" ? "✓" : item.state === "failed" ? "!" : "…"
          }}</span>
          {{ stepLabel(item.id) }}
        </li>
      </ol>
    </div>
    <NoticeBar v-if="error" intent="error">
      {{ error }}
      <template v-if="progress.some((item) => item.state === 'failed')" #actions>
        <FluentButton type="button" size="small" :disabled="loading" @click="retry">
          {{ t("deployWizard.retry") }}
        </FluentButton>
      </template>
    </NoticeBar>
    <NoticeBar v-if="result" intent="success" class="deploy-result">
      <strong>{{ t("deployWizard.result") }}</strong>
      <a v-if="result.url" :href="result.url" target="_blank" rel="noreferrer"
        >{{ t("deployWizard.open") }} ↗</a
      >
      <span v-else>{{ t("deployWizard.noUrl") }}</span>
    </NoticeBar>
  </section>
</template>
