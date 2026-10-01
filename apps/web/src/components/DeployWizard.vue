<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { Repository } from "../lib/api";

type Resource = { id: string; name: string; binding: string; migrations?: string[] };
type Plan = {
  repositoryId: string;
  ref: string;
  manifestDigest: string;
  permissions: string[];
  manifest: {
    name: string;
    license: { id: string; text: string };
    terms: { required: boolean; text: string };
    worker: {
      name?: string;
      entrypoint: string;
      modules: string[];
      compatibilityDate: string;
      vars: Record<string, string>;
    };
    resources: { d1: Resource[]; r2: Resource[]; kv: Resource[] };
  };
};
type Account = { id: string; name: string };
type ResourceAvailability = { id: string; exists: boolean };
type Progress = { step: string; state: "done" | "failed" };

const props = defineProps<{ repository: Repository }>();
const { locale } = useI18n();
const zh = computed(() => String(locale.value).startsWith("zh"));
const words = computed(() =>
  zh.value
    ? {
        title: "部署到 Cloudflare",
        intro: "读取所选仓库版本中的 gitedge.deploy.json，检查部署许可和资源权限。",
        ref: "分支或提交",
        load: "读取部署清单",
        token: "Cloudflare API Token",
        tokenHint: "令牌只在本次会话中使用，并保存在加密的 HttpOnly Cookie 中。",
        existing: "复用现有资源",
        createNew: "将创建",
        account: "Cloudflare 账户",
        createSession: "验证令牌并继续",
        chooseAccount: "选择账户",
        review: "部署计划",
        license: "许可证",
        terms: "使用条款",
        permissions: "所需权限",
        resources: "将创建或复用的资源",
        modules: "Worker 模块",
        migrations: "数据库迁移",
        variables: "Worker 变量",
        workerName: "Worker 名称",
        confirm: "我已审阅许可、条款和权限",
        deploy: "确认并部署",
        retry: "重试上次失败步骤",
        progress: "部署进度",
        result: "部署完成",
        open: "打开 Worker",
        noUrl: "Worker 已部署。此账户尚未启用 workers.dev 域名。",
        cancel: "关闭",
        error: "操作失败。请检查配置并重试。",
        accept: "请先确认许可、条款和权限。",
        migrated: "应用数据库迁移",
        provision: "准备资源",
        upload: "上传 Worker",
        chooseRef: "分支或提交 SHA",
      }
    : {
        title: "Deploy to Cloudflare",
        intro:
          "Read gitedge.deploy.json from the selected repository ref and review its license and resource permissions.",
        ref: "Branch or commit",
        load: "Read deployment manifest",
        token: "Cloudflare API token",
        tokenHint:
          "The token is used only for this session and stays in an encrypted HttpOnly cookie.",
        existing: "Existing resource will be reused",
        createNew: "Will create",
        account: "Cloudflare account",
        createSession: "Verify token and continue",
        chooseAccount: "Select account",
        review: "Deployment plan",
        license: "License",
        terms: "Terms",
        permissions: "Required permissions",
        resources: "Resources to create or reuse",
        modules: "Worker modules",
        migrations: "Database migrations",
        variables: "Worker variables",
        workerName: "Worker name",
        confirm: "I reviewed the license, terms, and permissions",
        deploy: "Confirm and deploy",
        retry: "Retry failed step",
        progress: "Deployment progress",
        result: "Deployment complete",
        open: "Open Worker",
        noUrl: "The Worker was deployed. This account has no workers.dev domain enabled.",
        cancel: "Close",
        error: "The operation failed. Check the configuration and retry.",
        accept: "Review and accept the license, terms, and permissions first.",
        migrated: "Apply database migrations",
        provision: "Prepare resources",
        upload: "Upload Worker",
        chooseRef: "Branch or commit SHA",
      }
);
const refName = ref(props.repository.defaultBranch || "HEAD");
const plan = ref<Plan | null>(null);
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
const result = ref<{ url: string | null } | null>(null);
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
  if (!response.ok) throw new Error(data.error?.message || words.value.error);
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
    plan.value = await call<Plan>("plan");
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
    error.value = cause instanceof Error ? cause.message : words.value.error;
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
    error.value = cause instanceof Error ? cause.message : words.value.error;
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
    error.value = cause instanceof Error ? cause.message : words.value.error;
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
async function runStep(name: string, label: string): Promise<unknown | null> {
  progress.value.push({ step: label, state: "failed" });
  const index = progress.value.length - 1;
  try {
    const body =
      name === "deploy"
        ? {
            workerName: workerName.value,
            confirmDigest: plan.value?.manifestDigest,
            nonce: sessionNonce.value,
          }
        : { nonce: sessionNonce.value, resourceNames: resourceNames.value };
    const data = await call(name, { method: "POST", body: JSON.stringify(body) });
    progress.value[index].state = "done";
    return data;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : words.value.error;
    return null;
  }
}
async function deploy() {
  if (!plan.value || !accepted.value) {
    error.value = words.value.accept;
    return;
  }
  loading.value = true;
  error.value = "";
  progress.value = [];
  try {
    if ((await runStep("provision", words.value.provision)) === null) return;
    if (plan.value.manifest.resources.d1.some((item) => item.migrations?.length))
      if ((await runStep("migrate", words.value.migrated)) === null) return;
    const deployed = (await runStep("deploy", words.value.upload)) as { url: string | null } | null;
    if (deployed) {
      result.value = deployed;
      step.value = "result";
    }
  } finally {
    loading.value = false;
  }
}
async function retry() {
  if (!plan.value) return;
  let failedIndex = -1;
  for (let index = progress.value.length - 1; index >= 0; index -= 1)
    if (progress.value[index].state === "failed") {
      failedIndex = index;
      break;
    }
  const failed = progress.value[failedIndex];
  if (!failed) return;
  loading.value = true;
  error.value = "";
  try {
    let outcome: unknown | null;
    if (failed.step === words.value.provision)
      outcome = await runStep("provision", words.value.provision);
    else if (failed.step === words.value.migrated)
      outcome = await runStep("migrate", words.value.migrated);
    else {
      const deployed = (await runStep("deploy", words.value.upload)) as {
        url: string | null;
      } | null;
      outcome = deployed;
      if (deployed) {
        result.value = deployed;
        step.value = "result";
      }
    }
    if (outcome !== null) progress.value[failedIndex].state = "done";
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
  () => plan.value?.manifest.resources.d1.flatMap((item) => item.migrations ?? []) ?? []
);
</script>

<template>
  <section class="panel deploy-wizard">
    <header>
      <div>
        <p class="eyebrow">{{ repository.owner }} / {{ repository.name }}</p>
        <h2>{{ words.title }}</h2>
        <p class="muted">{{ words.intro }}</p>
      </div>
    </header>
    <form v-if="step === 'read'" @submit.prevent="readPlan">
      <label
        >{{ words.ref
        }}<input v-model="refName" required maxlength="255" :placeholder="words.chooseRef"
      /></label>
      <button class="button primary" :disabled="loading">{{ loading ? "…" : words.load }}</button>
    </form>
    <form v-else-if="step === 'authorize'" @submit.prevent="startSession">
      <label
        >{{ words.token }}<input v-model="token" type="password" autocomplete="off" required
      /></label>
      <p class="muted">{{ words.tokenHint }}</p>
      <button class="button primary" :disabled="loading">{{ words.createSession }}</button>
    </form>
    <div v-else-if="step === 'review' && plan" class="deploy-review">
      <h3>{{ words.review }} · {{ plan.manifest.name }}</h3>
      <label v-if="accounts.length > 1"
        >{{ words.account
        }}<select v-model="accountId" @change="accountConfirmed = false">
          <option value="" disabled>{{ words.chooseAccount }}</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.name }}
          </option></select
        ><button class="button" type="button" @click="chooseAccount">
          {{ words.chooseAccount }}
        </button></label
      >
      <div v-else-if="accounts.length === 1">
        <strong>{{ words.account }}:</strong> {{ accounts[0].name }}
      </div>
      <h4>{{ words.permissions }}</h4>
      <ul>
        <li v-for="permission in plan.permissions" :key="permission">{{ permission }}</li>
      </ul>
      <h4>{{ words.modules }}</h4>
      <ul>
        <li v-for="module in plan.manifest.worker.modules" :key="module">{{ module }}</li>
        <li>{{ plan.manifest.worker.entrypoint }} · entrypoint</li>
      </ul>
      <h4 v-if="migrationPaths.length">{{ words.migrations }}</h4>
      <ul v-if="migrationPaths.length">
        <li v-for="migration in migrationPaths" :key="migration">{{ migration }}</li>
      </ul>
      <h4 v-if="Object.keys(plan.manifest.worker.vars).length">{{ words.variables }}</h4>
      <ul v-if="Object.keys(plan.manifest.worker.vars).length">
        <li v-for="(value, key) in plan.manifest.worker.vars" :key="key">
          {{ key }} = {{ value }}
        </li>
      </ul>
      <h4>{{ words.resources }}</h4>
      <div v-for="resource in resourceList" :key="resource.id" class="deploy-resource">
        <label
          >{{ resource.kind }} · {{ resource.binding
          }}<input
            v-model="resourceNames[resource.id]"
            required
            minlength="3"
            maxlength="48"
            pattern="[a-z][a-z0-9-]*"
            @change="loadResources" /></label
        ><small>{{ resourceAvailability[resource.id] ? words.existing : words.createNew }}</small>
      </div>
      <p v-if="!resourceList.length">—</p>
      <label>{{ words.workerName }}<input v-model="workerName" required maxlength="58" /></label>
      <details>
        <summary>{{ words.license }} · {{ plan.manifest.license.id }}</summary>
        <pre>{{ plan.manifest.license.text }}</pre>
      </details>
      <details v-if="plan.manifest.terms.text">
        <summary>{{ words.terms }}</summary>
        <pre>{{ plan.manifest.terms.text }}</pre>
      </details>
      <label class="checkbox"
        ><input v-model="accepted" type="checkbox" />{{ words.confirm }}</label
      >
      <button
        class="button primary"
        :disabled="loading || !accepted || (accounts.length > 1 && !accountConfirmed)"
        @click="deploy"
      >
        {{ words.deploy }}
      </button>
    </div>
    <div v-if="loading && progress.length" class="deploy-progress">
      <h3>{{ words.progress }}</h3>
      <ol>
        <li v-for="item in progress" :key="item.step">
          {{ item.state === "done" ? "✓" : "…" }} {{ item.step }}
        </li>
      </ol>
    </div>
    <div v-if="error" class="state error" role="alert">
      {{ error
      }}<button
        v-if="progress.some((item) => item.state === 'failed')"
        class="button ghost"
        @click="retry"
      >
        {{ words.retry }}
      </button>
    </div>
    <div v-if="result" class="deploy-result">
      <h3>{{ words.result }}</h3>
      <a v-if="result.url" :href="result.url" target="_blank" rel="noreferrer"
        >{{ words.open }} ↗</a
      >
      <p v-else>{{ words.noUrl }}</p>
    </div>
  </section>
</template>
