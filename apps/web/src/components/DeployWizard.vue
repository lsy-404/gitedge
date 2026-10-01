<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DeployPlan, DeployResult } from "../../../../packages/contracts/src/deploy";
import type { Repository } from "../lib/api";

type Account = { id: string; name: string };
type ResourceAvailability = { id: string; exists: boolean };
type DeployStepId = "provision" | "migrate" | "deploy";
type Progress = { id: DeployStepId; state: "pending" | "running" | "done" | "failed" };

const props = defineProps<{ repository: Repository }>();
const { t } = useI18n();
const refName = ref(props.repository.defaultBranch || "HEAD");
const plan = ref<DeployPlan | null>(null);
const token = ref("");
const accounts = ref<Account[]>([]);
const accountId = ref("");
const accountConfirmed = ref(false);
const sessionNonce = ref("");
const resourceNames = ref<Record<string, string>>({});
const resourceAvailability = ref<Record<string, boolean>>({});
const workerName = ref("");
const accepted = ref(false);
const loading = ref(false);
const error = ref("");
const progress = ref<Progress[]>([]);
const result = ref<DeployResult | null>(null);
const step = ref<"read" | "authorize" | "review" | "result">("read");
const endpoint = (name: string) =>
  `/api/deploy/${name}?repositoryId=${encodeURIComponent(props.repository.id)}&ref=${encodeURIComponent(refName.value)}`;

async function call<T>(name: string, init?: RequestInit): Promise<T> {
  const response = await fetch(endpoint(name), {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  const data = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || t("deployWizard.error"));
  return data.data as T;
}

onBeforeUnmount(() => {
  void fetch(endpoint("session"), { method: "DELETE", credentials: "include" }).catch(
    () => undefined
  );
});

async function readPlan() {
  loading.value = true;
  error.value = "";
  plan.value = null;
  try {
    plan.value = await call<DeployPlan>("plan");
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
    error.value = cause instanceof Error ? cause.message : t("deployWizard.error");
  } finally {
    loading.value = false;
  }
}

async function startSession() {
  if (!plan.value || !token.value) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await call<{ accounts: Account[]; nonce: string }>("session", {
      method: "POST",
      body: JSON.stringify({ token: token.value, manifestDigest: plan.value.manifestDigest }),
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
    error.value = cause instanceof Error ? cause.message : t("deployWizard.error");
  } finally {
    loading.value = false;
  }
}

async function chooseAccount() {
  if (!plan.value || !accountId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await call("account", {
      method: "POST",
      body: JSON.stringify({ accountId: accountId.value, nonce: sessionNonce.value }),
    });
    accountConfirmed.value = true;
    step.value = "review";
    await loadResources();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("deployWizard.error");
  } finally {
    loading.value = false;
  }
}

async function loadResources() {
  try {
    const data = await call<{ resources: ResourceAvailability[] }>("resources", {
      method: "POST",
      body: JSON.stringify({ nonce: sessionNonce.value, resourceNames: resourceNames.value }),
    });
    resourceAvailability.value = Object.fromEntries(
      data.resources.map((item) => [item.id, item.exists])
    );
  } catch {
    resourceAvailability.value = {};
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
    const data = await call<T>(id, { method: "POST", body: JSON.stringify(body) });
    progressStep.state = "done";
    return data;
  } catch (cause) {
    progressStep.state = "failed";
    error.value = cause instanceof Error ? cause.message : t("deployWizard.error");
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
      <label for="deploy-ref">{{ t("deployWizard.ref") }}</label>
      <input
        id="deploy-ref"
        v-model="refName"
        required
        maxlength="255"
        :placeholder="t('deployWizard.chooseRef')"
      />
      <button class="btn primary" :disabled="loading">
        {{ loading ? "…" : t("deployWizard.load") }}
      </button>
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
        <pre>{{ plan.manifest.license.text }}</pre>
      </details>
      <details v-if="plan.manifest.terms.text" class="deploy-disclosure">
        <summary>
          {{ t("deployWizard.terms")
          }}<span v-if="plan.manifest.terms.required"> · {{ t("deployWizard.required") }}</span>
        </summary>
        <pre>{{ plan.manifest.terms.text }}</pre>
      </details>
      <form v-if="step === 'authorize'" class="deploy-token-form" @submit.prevent="startSession">
        <label for="deploy-token">{{ t("deployWizard.token") }}</label>
        <input id="deploy-token" v-model="token" type="password" autocomplete="off" required />
        <p class="muted">{{ t("deployWizard.tokenHint") }}</p>
        <button class="btn primary" :disabled="loading">
          {{ t("deployWizard.createSession") }}
        </button>
      </form>
      <template v-else>
        <div v-if="accounts.length > 1" class="deploy-field">
          <label for="deploy-account">{{ t("deployWizard.account") }}</label>
          <select id="deploy-account" v-model="accountId" @change="accountConfirmed = false">
            <option value="" disabled>{{ t("deployWizard.chooseAccount") }}</option>
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.name }}
            </option>
          </select>
          <button class="btn" type="button" :disabled="loading" @click="chooseAccount">
            {{ t("deployWizard.chooseAccount") }}
          </button>
        </div>
        <p v-else-if="accounts.length === 1" class="deploy-account">
          <strong>{{ t("deployWizard.account") }}:</strong> {{ accounts[0].name }}
        </p>
        <div v-if="accountConfirmed" class="deploy-resource-controls">
          <div v-for="resource in resourceList" :key="resource.id" class="deploy-resource">
            <label :for="`deploy-resource-${resource.id}`"
              >{{ resource.kind }} · {{ resource.binding }}</label
            >
            <input
              :id="`deploy-resource-${resource.id}`"
              v-model="resourceNames[resource.id]"
              required
              minlength="3"
              maxlength="48"
              pattern="[a-z][a-z0-9-]*"
              @change="loadResources"
            />
            <small>{{
              resourceAvailability[resource.id]
                ? t("deployWizard.existing")
                : t("deployWizard.createNew")
            }}</small>
          </div>
          <label class="deploy-field" for="deploy-worker-name">{{
            t("deployWizard.workerName")
          }}</label>
          <input id="deploy-worker-name" v-model="workerName" required maxlength="58" />
        </div>
        <form class="deploy-confirm-form" @submit.prevent="deploy">
          <label class="checkbox" for="deploy-confirm">
            <input id="deploy-confirm" v-model="accepted" type="checkbox" />
            <span>{{ t("deployWizard.confirm") }}</span>
          </label>
          <button
            class="btn primary"
            :disabled="loading || !accepted || (accounts.length > 1 && !accountConfirmed)"
          >
            {{ t("deployWizard.deploy") }}
          </button>
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
    <div v-if="error" class="state error" role="alert">
      {{ error }}
      <button
        v-if="progress.some((item) => item.state === 'failed')"
        class="btn ghost"
        :disabled="loading"
        @click="retry"
      >
        {{ t("deployWizard.retry") }}
      </button>
    </div>
    <div v-if="result" class="deploy-result">
      <h3>{{ t("deployWizard.result") }}</h3>
      <a v-if="result.url" :href="result.url" target="_blank" rel="noreferrer"
        >{{ t("deployWizard.open") }} ↗</a
      >
      <p v-else>{{ t("deployWizard.noUrl") }}</p>
    </div>
  </section>
</template>
