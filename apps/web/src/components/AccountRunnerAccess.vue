<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import { SigningSourceCredentialSchema } from "../../../../packages/contracts/src/signing";
import type { SigningSourceCredentialStatus } from "../../../../packages/contracts/src/signing";
import { ApiError, errorMessage } from "../lib/api";
import {
  getSigningSourceCredentialStatus,
  installSigningSourceCredential,
  removeSigningSourceCredential,
} from "../lib/runnerSigning";
import { useReauthRetry } from "../lib/reauth";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import TextField from "./TextField.vue";

const props = defineProps<{ repositoryId: string }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const status = ref<SigningSourceCredentialStatus | null>(null);
const token = ref("");
const editing = ref(false);
const busy = ref(false);
const error = ref("");

function failure(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === "github_token_invalid")
    return t("runnerAccessTokenInvalid");
  return errorMessage(cause, t);
}

async function refresh(): Promise<void> {
  error.value = "";
  try {
    status.value = await getSigningSourceCredentialStatus(props.repositoryId);
  } catch (cause) {
    if (reauth.intercept(cause, refresh)) return;
    error.value = failure(cause);
  }
}

async function save(): Promise<void> {
  const value = token.value.trim();
  if (busy.value || !SigningSourceCredentialSchema.safeParse({ token: value }).success) return;
  const operation = async () => {
    busy.value = true;
    error.value = "";
    try {
      status.value = await installSigningSourceCredential(props.repositoryId, value);
      token.value = "";
      editing.value = false;
    } catch (cause) {
      if (reauth.intercept(cause, operation)) return;
      error.value = failure(cause);
    } finally {
      busy.value = false;
    }
  };
  await operation();
}

async function revoke(): Promise<void> {
  if (busy.value || !window.confirm(t("runnerSigningSourceRemoveConfirm"))) return;
  const operation = async () => {
    busy.value = true;
    error.value = "";
    try {
      status.value = await removeSigningSourceCredential(props.repositoryId);
      editing.value = false;
    } catch (cause) {
      if (reauth.intercept(cause, operation)) return;
      error.value = failure(cause);
    } finally {
      busy.value = false;
    }
  };
  await operation();
}

function cancel(): void {
  token.value = "";
  editing.value = false;
}

onMounted(() => void refresh());
</script>

<template>
  <section class="box access-card" :aria-label="t('runnerAccessTitle')">
    <h3>{{ t("runnerAccessTitle") }}</h3>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
    <ul v-if="status?.configured" class="token-list">
      <li class="token-row">
        <div>
          <strong>{{ status.login ? `@${status.login}` : t("runnerAccessTokenName") }}</strong>
          <span class="row-meta">
            · {{ t("runnerSigningCredentialConfigured")
            }}<template v-if="status.updatedAt">
              · {{ d(new Date(status.updatedAt), "long") }}</template
            ></span
          >
          <p class="row-meta">{{ t("runnerAccessUsage") }}</p>
        </div>
        <div class="token-actions">
          <FluentButton
            type="button"
            :disabled="busy"
            @click="editing ? cancel() : (editing = true)"
            >{{ editing ? t("runnerAccessCancel") : t("runnerAccessReplace") }}</FluentButton
          >
          <FluentButton type="button" tone="danger" :disabled="busy" @click="revoke">{{
            t("runnerSigningSourceRemove")
          }}</FluentButton>
        </div>
      </li>
    </ul>
    <p v-else-if="status" class="row-meta">{{ t("runnerAccessEmpty") }}</p>
    <form
      v-if="status && (!status.configured || editing)"
      class="token-form"
      @submit.prevent="save"
    >
      <TextField
        v-model="token"
        type="password"
        autocomplete="new-password"
        spellcheck="false"
        maxlength="512"
        required
        :disabled="busy"
        >{{ t("runnerSigningSourceToken") }}</TextField
      >
      <FluentButton type="submit" tone="primary" :busy="busy" :disabled="busy || !token.trim()">{{
        t("runnerSigningSourceSave")
      }}</FluentButton>
    </form>
  </section>
</template>

<style scoped>
.access-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}
.access-card h3,
.access-card p {
  margin: 0;
}
.token-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.token-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.token-actions {
  display: flex;
  gap: var(--space-2);
}
.token-form {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  max-width: 38rem;
}
</style>
