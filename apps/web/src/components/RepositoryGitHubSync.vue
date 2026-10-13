<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentCheckbox, FluentField } from "@platform-kit/fluent/vue";
import type {
  GitHubSyncJob,
  GitHubSyncState,
} from "../../../../packages/contracts/src/github-sync";
import { api, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repositoryId: string; canManage: boolean }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const state = ref<GitHubSyncState | null>(null);
const loading = ref(true);
const loadError = ref("");
const actionError = ref("");
const notice = ref("");
const busy = ref(false);
const owner = ref("");
const repository = ref("");
const token = ref("");
const allowVisibilityMismatch = ref(false);
let version = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let requestInFlight = false;

const connection = computed(() => state.value?.connection ?? null);
const latestJobs = computed(() => (state.value?.jobs ?? []).slice(0, 10));
const jobStatusKeys: Record<GitHubSyncJob["status"], string> = {
  pending: "githubSyncStatus_pending",
  running: "githubSyncStatus_running",
  success: "githubSyncStatus_success",
  conflict: "githubSyncStatus_conflict",
  failed: "githubSyncStatus_failed",
  ignored: "githubSyncStatus_ignored",
};
const canConfigure = computed(
  () =>
    props.canManage &&
    owner.value.trim() !== "" &&
    repository.value.trim() !== "" &&
    token.value !== ""
);

async function load(): Promise<void> {
  const currentVersion = version;
  requestInFlight = true;
  loadError.value = "";
  try {
    const result = await api.githubSyncState(props.repositoryId);
    if (currentVersion === version) {
      state.value = result;
      owner.value ||= result.connection?.owner ?? "";
      repository.value ||= result.connection?.repository ?? "";
    }
  } catch {
    if (currentVersion === version) loadError.value = t("githubSyncLoadError");
  } finally {
    if (currentVersion === version) {
      requestInFlight = false;
      loading.value = false;
    }
  }
}

function scheduleRefresh(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (connection.value && !requestInFlight && !busy.value) void load();
  }, 5000);
}

async function save(): Promise<void> {
  if (!canConfigure.value || busy.value) return;
  const currentVersion = version;
  busy.value = true;
  actionError.value = "";
  notice.value = "";
  try {
    const result = await api.saveGitHubSync(props.repositoryId, {
      owner: owner.value.trim(),
      repository: repository.value.trim(),
      token: token.value,
      allowVisibilityMismatch: allowVisibilityMismatch.value,
    });
    if (currentVersion !== version) return;
    state.value = result;
    token.value = "";
    owner.value = result.connection?.owner ?? owner.value.trim();
    repository.value = result.connection?.repository ?? repository.value.trim();
    notice.value = t("githubSyncSaved");
  } catch (cause) {
    if (reauth.intercept(cause, save)) return;
    actionError.value = errorMessage(cause, t, {}, "githubSyncActionError");
  } finally {
    busy.value = false;
  }
}

async function updateState(action: () => Promise<GitHubSyncState>): Promise<void> {
  if (busy.value) return;
  const currentVersion = version;
  busy.value = true;
  actionError.value = "";
  notice.value = "";
  try {
    const result = await action();
    if (currentVersion !== version) return;
    state.value = result;
    if (!result.connection) notice.value = t("githubSyncDisconnected");
  } catch (cause) {
    if (reauth.intercept(cause, () => updateState(action))) return;
    actionError.value = errorMessage(cause, t, {}, "githubSyncActionError");
  } finally {
    busy.value = false;
  }
}

function retry(job: GitHubSyncJob): void {
  void updateState(() => api.retryGitHubSyncJob(props.repositoryId, job.id));
}

function toggleEnabled(): void {
  const current = connection.value;
  if (current)
    void updateState(() => api.setGitHubSyncEnabled(props.repositoryId, !current.enabled));
}

function statusTone(job: GitHubSyncJob): "success" | "warning" | "danger" | "neutral" {
  if (job.status === "success") return "success";
  if (job.status === "conflict") return "warning";
  if (job.status === "failed") return "danger";
  return "neutral";
}

watch(
  () => [props.repositoryId, props.canManage] as const,
  ([, canManage]) => {
    version += 1;
    state.value = null;
    loadError.value = "";
    actionError.value = "";
    notice.value = "";
    reauth.pending.value = null;
    token.value = "";
    owner.value = "";
    repository.value = "";
    loading.value = canManage;
    if (canManage) void load();
    else loading.value = false;
  },
  { immediate: true }
);
scheduleRefresh();

onBeforeUnmount(() => {
  version += 1;
  token.value = "";
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="box github-sync" aria-labelledby="github-sync-title">
    <header class="box-header">
      <h3 id="github-sync-title">{{ t("githubSyncTitle") }}</h3>
      <FluentButton type="button" :disabled="loading || busy" @click="load">{{
        t("githubSyncRefresh")
      }}</FluentButton>
    </header>
    <p class="box-row field-hint">{{ t("githubSyncIntro") }}</p>
    <NoticeBar v-if="!canManage" intent="info">{{ t("settingsOwnerOnly") }}</NoticeBar>
    <StatusState
      v-else-if="loading || loadError"
      :loading="loading"
      :error="loadError"
      @retry="load"
    />
    <template v-else>
      <div v-if="connection" class="github-sync-connection box-row">
        <div class="github-sync-summary">
          <div class="row-title">
            <a :href="connection.githubUrl" target="_blank" rel="noreferrer">
              {{ connection.owner }}/{{ connection.repository }}
            </a>
            <StatusBadge :tone="connection.enabled ? 'success' : 'neutral'">{{
              t(connection.enabled ? "githubSyncEnabled" : "githubSyncDisabled")
            }}</StatusBadge>
            <StatusBadge :tone="connection.webhookReady ? 'success' : 'warning'">{{
              t(connection.webhookReady ? "githubSyncWebhookReady" : "githubSyncWebhookPending")
            }}</StatusBadge>
          </div>
          <small>
            {{ t("githubSyncLastSuccess") }}:
            {{
              connection.lastSyncedAt === null
                ? t("githubSyncNever")
                : d(connection.lastSyncedAt, "long")
            }}
          </small>
          <div class="github-sync-counts">
            <span>{{ t("githubSyncPendingCount") }}: {{ connection.pending }}</span>
            <span>{{ t("githubSyncConflictCount") }}: {{ connection.conflicts }}</span>
            <span>{{ t("githubSyncFailedCount") }}: {{ connection.failed }}</span>
          </div>
        </div>
        <div class="settings-actions">
          <FluentButton type="button" :disabled="busy" @click="toggleEnabled">{{
            t(connection.enabled ? "githubSyncPause" : "githubSyncResume")
          }}</FluentButton>
          <FluentButton
            type="button"
            :disabled="busy"
            :busy="busy"
            @click="updateState(() => api.reconcileGitHubSync(props.repositoryId))"
            >{{ t("githubSyncReconcile") }}</FluentButton
          >
          <ConfirmButton
            tone="secondary"
            :label="t('githubSyncDisconnect')"
            :prompt="t('githubSyncDisconnectConfirm')"
            :disabled="busy"
            @confirm="updateState(() => api.disconnectGitHubSync(props.repositoryId))"
          />
        </div>
      </div>

      <section v-if="connection" class="github-sync-jobs" :aria-label="t('githubSyncJobs')">
        <header class="box-header">
          <h4>{{ t("githubSyncJobs") }}</h4>
        </header>
        <p v-if="!latestJobs.length" class="box-row muted">{{ t("githubSyncNoJobs") }}</p>
        <ul v-else class="settings-list">
          <li v-for="job in latestJobs" :key="job.id" class="box-row github-sync-job">
            <div class="github-sync-summary">
              <div class="row-title">
                <StatusBadge :tone="statusTone(job)">{{
                  t(jobStatusKeys[job.status])
                }}</StatusBadge>
                {{ job.event }} ·
                {{
                  t(
                    job.direction === "inbound"
                      ? "githubSyncDirectionInbound"
                      : "githubSyncDirectionOutbound"
                  )
                }}
              </div>
              <small>
                {{ d(job.createdAt, "long") }} ·
                {{ t("githubSyncAttempts", { count: job.attempts }) }}
                <template v-if="job.errorCode"> · {{ job.errorCode }}</template>
              </small>
            </div>
            <FluentButton
              v-if="job.status === 'conflict' || job.status === 'failed'"
              size="small"
              type="button"
              :disabled="busy"
              @click="retry(job)"
              >{{ t("githubSyncRetry") }}</FluentButton
            >
          </li>
        </ul>
      </section>

      <div class="github-sync-config box-row">
        <div class="row-copy">
          <strong>{{ connection ? t("githubSyncUpdate") : t("githubSyncConnect") }}</strong>
          <p>{{ t("githubSyncTokenHint") }}</p>
        </div>
        <div class="github-sync-fields">
          <FluentField v-model="owner" :label="t('githubSyncOwner')" :disabled="busy" />
          <FluentField v-model="repository" :label="t('githubSyncRepository')" :disabled="busy" />
          <FluentField
            v-model="token"
            :label="t('githubSyncToken')"
            type="password"
            autocomplete="new-password"
            :disabled="busy"
          />
          <FluentCheckbox
            v-model="allowVisibilityMismatch"
            :label="t('githubSyncVisibilityMismatch')"
            :disabled="busy"
          />
          <p class="field-hint">{{ t("githubSyncVisibilityHint") }}</p>
          <FluentButton type="button" :disabled="!canConfigure || busy" :busy="busy" @click="save">
            {{ connection ? t("githubSyncUpdate") : t("githubSyncConnect") }}
          </FluentButton>
        </div>
      </div>
      <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
      <NoticeBar v-else-if="notice" intent="success">{{ notice }}</NoticeBar>
    </template>
    <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
  </section>
</template>

<style scoped>
.github-sync-summary,
.github-sync-fields {
  display: grid;
  gap: var(--space-2);
}

.github-sync-connection,
.github-sync-job {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.github-sync-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.github-sync-config {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) minmax(18rem, 2fr);
  gap: var(--space-4);
}

.github-sync-jobs .box-header {
  padding-inline: var(--space-4);
}

@media (max-width: 48rem) {
  .github-sync-connection,
  .github-sync-job {
    align-items: flex-start;
    flex-direction: column;
  }

  .github-sync-config {
    grid-template-columns: 1fr;
  }
}
</style>
