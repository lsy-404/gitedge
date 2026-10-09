<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import {
  FluentButton,
  FluentCheckbox,
  FluentField,
  FluentSelect,
  type FluentSelectOption,
} from "@platform-kit/fluent/vue";
import {
  ACCESS_TOKEN_EXPIRY_PRESET_DAYS,
  AccessTokenScopes,
  type AccessToken,
  type AccessTokenScope,
} from "../../../../packages/contracts/src/access-tokens";
import type { Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const { t, d } = useI18n();
const tokens = ref<AccessToken[]>([]);
const repositories = ref<Repository[]>([]);
const name = ref("");
const selectedScopes = ref<AccessTokenScope[]>(["repo:read"]);
const expiryDays = ref("30");
const repositoryMode = ref<"all" | "selected">("all");
const selectedRepositories = ref<string[]>([]);
const loading = ref(true);
const loadingError = ref("");
const actionError = ref("");
const creating = ref(false);
const revokingId = ref("");
const oneTime = ref<{ token: string; expiresAt: number } | null>(null);
const copied = ref(false);
const now = ref(Date.now());
let copiedTimer: number | undefined;
let clockTimer: number | undefined;

const expiryOptions = computed<readonly FluentSelectOption[]>(() =>
  ACCESS_TOKEN_EXPIRY_PRESET_DAYS.map((days) => ({
    value: String(days),
    label: t("patDays", { days }),
  }))
);
const repositoryModeOptions = computed<readonly FluentSelectOption[]>(() => [
  { value: "all", label: t("patRepositoriesAll") },
  { value: "selected", label: t("patRepositoriesSelected") },
]);
const canCreate = computed(
  () =>
    !loading.value &&
    !creating.value &&
    name.value.trim().length > 0 &&
    selectedScopes.value.length > 0 &&
    (repositoryMode.value === "all" || selectedRepositories.value.length > 0)
);

function scopeLabel(scope: AccessTokenScope): string {
  return t(`patScope_${scope.replace(":", "_")}`);
}

function toggleScope(scope: AccessTokenScope, checked: boolean): void {
  selectedScopes.value = checked
    ? [...selectedScopes.value, scope]
    : selectedScopes.value.filter((value) => value !== scope);
}

function toggleRepository(id: string, checked: boolean): void {
  selectedRepositories.value = checked
    ? [...selectedRepositories.value, id]
    : selectedRepositories.value.filter((value) => value !== id);
}

function statusLabel(token: AccessToken): string {
  if (token.revokedAt !== null) return t("patRevoked");
  return token.expiresAt <= now.value ? t("patExpired") : t("patActive");
}

function statusTone(token: AccessToken): "neutral" | "success" | "danger" {
  if (token.revokedAt !== null) return "neutral";
  return token.expiresAt <= now.value ? "danger" : "success";
}

function isActive(token: AccessToken): boolean {
  return token.revokedAt === null && token.expiresAt > now.value;
}

function clearOneTime(): void {
  oneTime.value = null;
  copied.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  loadingError.value = "";
  try {
    const [tokenRows, repositoryRows] = await Promise.all([api.accessTokens(), api.repositories()]);
    tokens.value = tokenRows;
    repositories.value = repositoryRows;
  } catch (cause) {
    loadingError.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

async function createToken(): Promise<void> {
  if (!canCreate.value) return;
  creating.value = true;
  actionError.value = "";
  try {
    const created = await api.createAccessToken({
      name: name.value.trim(),
      scopes: selectedScopes.value,
      expiresInDays: Number(expiryDays.value),
      ...(repositoryMode.value === "selected" ? { repositoryIds: selectedRepositories.value } : {}),
    });
    oneTime.value = { token: created.token, expiresAt: created.expiresAt };
    name.value = "";
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    creating.value = false;
  }
}

async function copyToken(): Promise<void> {
  if (!oneTime.value) return;
  try {
    await navigator.clipboard.writeText(oneTime.value.token);
    copied.value = true;
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = false), 2000);
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  }
}

async function revokeToken(token: AccessToken): Promise<void> {
  if (revokingId.value) return;
  revokingId.value = token.id;
  actionError.value = "";
  try {
    await api.revokeAccessToken(token.id);
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
  clearOneTime();
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
}
onBeforeRouteLeave(dispose);
onUnmounted(dispose);
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("patTitle") }}</h2>
        <p>{{ t("patDescription") }}</p>
      </div>
      <FluentButton type="button" tone="subtle" :busy="loading" @click="load">
        {{ t("refresh") }}
      </FluentButton>
    </header>
    <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
    <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>

    <div v-if="oneTime" class="box box-form form-stack" aria-live="polite">
      <NoticeBar intent="success">{{ t("patOnce") }}</NoticeBar>
      <FluentField :model-value="oneTime.token" :label="t('patTokenValue')" readonly type="text" />
      <p class="field-hint">{{ t("patPasteHint") }}</p>
      <div class="settings-actions">
        <FluentButton type="button" tone="secondary" @click="copyToken">
          {{ copied ? t("settingsCopied") : t("patCopyToken") }}
        </FluentButton>
        <FluentButton type="button" tone="subtle" @click="clearOneTime">
          {{ t("patDismiss") }}
        </FluentButton>
      </div>
    </div>

    <form class="box" aria-labelledby="pat-create-title" @submit.prevent="createToken">
      <header class="box-header">
        <h3 id="pat-create-title">{{ t("patCreate") }}</h3>
      </header>
      <div class="box-form form-stack">
        <FluentField v-model="name" :label="t('patName')" :disabled="loading" type="text" />
        <fieldset class="pat-scopes">
          <legend>{{ t("patScopes") }}</legend>
          <FluentCheckbox
            v-for="scope in AccessTokenScopes"
            :key="scope"
            :model-value="selectedScopes.includes(scope)"
            :label="scopeLabel(scope)"
            @update:model-value="toggleScope(scope, $event)"
          />
        </fieldset>
        <FluentSelect
          v-model="expiryDays"
          :label="t('patExpiry')"
          :options="expiryOptions"
          :disabled="loading"
        />
        <FluentSelect
          v-model="repositoryMode"
          :label="t('patRepositories')"
          :options="repositoryModeOptions"
          :disabled="loading"
        />
        <fieldset v-if="repositoryMode === 'selected'" class="pat-scopes">
          <legend>{{ t("patRepositoriesSelected") }}</legend>
          <FluentCheckbox
            v-for="repository in repositories"
            :key="repository.id"
            :model-value="selectedRepositories.includes(repository.id)"
            :label="`${repository.owner}/${repository.name}`"
            @update:model-value="toggleRepository(repository.id, $event)"
          />
        </fieldset>
        <div class="form-actions">
          <FluentButton type="submit" tone="primary" :busy="creating" :disabled="!canCreate">
            {{ t("patCreate") }}
          </FluentButton>
        </div>
      </div>
    </form>

    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <section
      v-else-if="!loadingError || tokens.length"
      class="box"
      aria-labelledby="pat-list-title"
    >
      <header class="box-header">
        <h3 id="pat-list-title">{{ t("patList") }}</h3>
        <StatusBadge>{{ tokens.length }}</StatusBadge>
      </header>
      <p v-if="!tokens.length" class="settings-empty">{{ t("patNone") }}</p>
      <ul v-else class="settings-list">
        <li v-for="token in tokens" :key="token.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ token.name }}
              <StatusBadge :tone="statusTone(token)">{{ statusLabel(token) }}</StatusBadge>
            </div>
            <div class="row-meta">
              <code>{{ token.prefix }}…</code>
              <span>{{ token.scopes.map(scopeLabel).join(", ") }}</span>
              <span v-if="token.repositories">{{
                token.repositories.map((item) => `${item.owner}/${item.slug}`).join(", ") ||
                t("patRepositoriesSelected")
              }}</span>
              <span>{{ t("patExpires") }}: {{ d(token.expiresAt, "long") }}</span>
              <span
                >{{ t("patLastUsed") }}:
                {{
                  token.lastUsedAt === null ? t("patNeverUsed") : d(token.lastUsedAt, "long")
                }}</span
              >
            </div>
          </div>
          <div class="settings-actions">
            <ConfirmButton
              v-if="isActive(token)"
              :label="t('patRevoke')"
              :prompt="t('patRevokePrompt')"
              :busy="revokingId === token.id"
              :disabled="Boolean(revokingId)"
              @confirm="revokeToken(token)"
            />
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>
