<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import {
  FluentButton,
  FluentField,
  FluentSelect,
  type FluentSelectOption,
} from "@platform-kit/fluent/vue";
import type { GitCredential } from "../../../../packages/contracts/src/credentials";
import type { Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";

interface OneTimeCredential {
  token: string;
  expiresAt: number;
}

const { t, locale, d } = useI18n();
const credentials = ref<GitCredential[]>([]);
const repositories = ref<Repository[]>([]);
const repositoryId = ref("");
const credentialName = ref("");
const permission = ref<"read" | "write">("read");
const ttlSeconds = ref("86400");
const loading = ref(true);
const loadingError = ref("");
const actionError = ref("");
const creating = ref(false);
const revokingId = ref("");
const oneTimeCredential = ref<OneTimeCredential | null>(null);
const copied = ref(false);
const now = ref(Date.now());
let secretExpiryTimer: number | undefined;
let copiedTimer: number | undefined;
let clockTimer: number | undefined;
let secretRequestVersion = 0;

const selectedRepository = computed(
  () => repositories.value.find((repository) => repository.id === repositoryId.value) ?? null
);
const archivedRepositoryNotice = computed(() =>
  locale.value.startsWith("zh")
    ? "已归档仓库只能创建只读凭证。"
    : "Archived repositories can only use read-only credentials."
);
const repositoryOptions = computed<readonly FluentSelectOption[]>(() =>
  repositories.value.map((repository) => ({
    value: repository.id,
    label: `${repository.owner}/${repository.name}`,
  }))
);
const permissionOptions = computed<readonly FluentSelectOption[]>(() => [
  { value: "read", label: t("readToken") },
  { value: "write", label: t("writeToken"), disabled: selectedRepository.value?.archived ?? false },
]);
const expiryOptions = computed<readonly FluentSelectOption[]>(() => [
  { value: "86400", label: t("settingsOneDay") },
  { value: "604800", label: t("settingsSevenDays") },
  { value: "2592000", label: t("settingsThirtyDays") },
]);
const canCreate = computed(
  () =>
    !loading.value &&
    !creating.value &&
    Boolean(selectedRepository.value) &&
    credentialName.value.trim().length > 0 &&
    !(selectedRepository.value?.archived && permission.value === "write")
);

watch(selectedRepository, (repository) => {
  if (repository?.archived && permission.value === "write") permission.value = "read";
});

function statusLabel(credential: GitCredential): string {
  if (credential.revokedAt !== null) return t("settingsRevoked");
  return credential.expiresAt <= now.value ? t("settingsExpired") : t("settingsActive");
}

function statusTone(credential: GitCredential): "neutral" | "success" | "danger" {
  if (credential.revokedAt !== null) return "neutral";
  return credential.expiresAt <= now.value ? "danger" : "success";
}

function repositoryLabel(credential: GitCredential): string {
  const repository = repositories.value.find((item) => item.id === credential.repositoryId);
  return repository ? `${repository.owner}/${repository.name}` : credential.repositoryId;
}

function clearOneTimeCredential(): void {
  secretRequestVersion += 1;
  if (secretExpiryTimer !== undefined) window.clearTimeout(secretExpiryTimer);
  secretExpiryTimer = undefined;
  oneTimeCredential.value = null;
  copied.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  loadingError.value = "";
  try {
    const [tokenRows, repositoryRows] = await Promise.all([
      api.gitCredentials(),
      api.repositories(),
    ]);
    credentials.value = tokenRows;
    repositories.value = repositoryRows;
    if (!repositoryId.value && repositoryRows[0]) repositoryId.value = repositoryRows[0].id;
  } catch (cause) {
    loadingError.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

async function createCredential(): Promise<void> {
  if (!canCreate.value || !selectedRepository.value) return;
  const requestVersion = ++secretRequestVersion;
  creating.value = true;
  actionError.value = "";
  try {
    const created = await api.createCloneToken({
      repositoryId: selectedRepository.value.id,
      name: credentialName.value.trim(),
      permission: permission.value,
      ttlSeconds: Number(ttlSeconds.value),
    });
    if (requestVersion !== secretRequestVersion) return;
    clearOneTimeCredential();
    oneTimeCredential.value = { token: created.token, expiresAt: created.expiresAt };
    secretExpiryTimer = window.setTimeout(
      clearOneTimeCredential,
      Math.min(2_147_483_647, Math.max(0, created.expiresAt - Date.now()))
    );
    credentialName.value = "";
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    creating.value = false;
  }
}

async function copyCredential(): Promise<void> {
  if (!oneTimeCredential.value) return;
  try {
    await navigator.clipboard.writeText(oneTimeCredential.value.token);
    copied.value = true;
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = false), 2000);
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  }
}

async function revokeCredential(credential: GitCredential): Promise<void> {
  revokingId.value = credential.id;
  actionError.value = "";
  try {
    await api.revokeGitCredential(credential.id);
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    revokingId.value = "";
  }
}

onMounted(() => {
  void load();
  clockTimer = window.setInterval(() => (now.value = Date.now()), 30_000);
});
function dispose(): void {
  clearOneTimeCredential();
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
}
onBeforeRouteLeave(dispose);
onUnmounted(dispose);
</script>

<template>
  <section class="preference-panel">
    <div class="settings-section-heading">
      <h2 class="settings-page-title">{{ t("settingsCredentials") }}</h2>
      <FluentButton type="button" tone="subtle" :busy="loading" @click="load">
        {{ t("refresh") }}
      </FluentButton>
    </div>
    <p class="muted">{{ t("settingsTokenDescription") }}</p>
    <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
    <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>

    <div v-if="oneTimeCredential" class="settings-surface form-stack" aria-live="polite">
      <NoticeBar intent="success">{{ t("settingsTokenOnce") }}</NoticeBar>
      <FluentField
        :model-value="oneTimeCredential.token"
        :label="t('settingsTokenValue')"
        readonly
        type="text"
      />
      <p class="muted">{{ t("settingsTokenInstructions") }}</p>
      <pre class="settings-code">Authorization: Bearer &lt;token&gt;</pre>
      <div class="settings-actions">
        <FluentButton type="button" tone="secondary" @click="copyCredential">
          {{ copied ? t("settingsCopied") : t("settingsCopy") }}
        </FluentButton>
        <FluentButton type="button" tone="subtle" @click="clearOneTimeCredential">
          {{ t("settingsDismissSecret") }}
        </FluentButton>
      </div>
    </div>

    <form class="settings-surface form-stack" @submit.prevent="createCredential">
      <FluentField
        v-model="credentialName"
        :label="t('settingsTokenName')"
        :disabled="loading || !repositories.length"
        type="text"
      />
      <p v-if="!repositories.length && !loading" class="muted">
        {{ t("settingsTokenRepoMissing") }}
      </p>
      <FluentSelect
        v-model="repositoryId"
        :label="t('settingsTokenRepo')"
        :options="repositoryOptions"
        :disabled="loading || !repositories.length"
      />
      <p v-if="selectedRepository?.archived" class="muted">{{ archivedRepositoryNotice }}</p>
      <FluentSelect
        v-model="permission"
        :label="t('settingsTokenPermission')"
        :options="permissionOptions"
        :disabled="loading || !repositories.length"
      />
      <FluentSelect
        v-model="ttlSeconds"
        :label="t('settingsTokenExpiry')"
        :options="expiryOptions"
        :disabled="loading"
      />
      <div class="settings-actions">
        <FluentButton type="submit" tone="primary" :busy="creating" :disabled="!canCreate">
          {{ t("settingsCreateToken") }}
        </FluentButton>
      </div>
    </form>

    <div v-if="loading" class="state" role="status">{{ t("loading") }}</div>
    <div v-else-if="!loadingError && !credentials.length" class="settings-surface muted">
      {{ t("settingsNoTokens") }}
    </div>
    <div v-else class="credential-list">
      <article v-for="credential in credentials" :key="credential.id" class="settings-surface">
        <div class="credential-row">
          <div>
            <h3>{{ credential.name }}</h3>
            <p class="muted">{{ repositoryLabel(credential) }}</p>
            <p class="muted">
              {{ credential.permission === "read" ? t("readToken") : t("writeToken") }} ·
              {{ t("settingsTokenExpiry") }}: {{ d(credential.expiresAt, "long") }}
            </p>
            <StatusBadge :tone="statusTone(credential)">{{ statusLabel(credential) }}</StatusBadge>
          </div>
          <div class="settings-actions">
            <ConfirmButton
              v-if="credential.revokedAt === null && credential.expiresAt > now"
              :label="t('settingsRevoke')"
              :prompt="t('confirmRevokeCredential')"
              :busy="revokingId === credential.id"
              :disabled="Boolean(revokingId)"
              @confirm="revokeCredential(credential)"
            />
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
