<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  BrowserAccount,
  BrowserAccounts,
  BrowserAgentView,
} from "../../../../packages/contracts/src/browser-accounts";
import AppIcon from "./AppIcon.vue";
import { ApiError, api, setExpectedIdentity } from "../lib/api";
import { sessionState } from "../lib/session";

const emit = defineEmits<{
  "identity-switch": [target: string];
  "add-account": [];
}>();
const { locale, t } = useI18n();
const accounts = ref<BrowserAccounts | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref("");

onMounted(() => void loadAccounts());

async function loadAccounts(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    accounts.value = await api.browserAccounts();
    if (!sessionState.user && accounts.value.activeAccountId) {
      setExpectedIdentity(accounts.value.activeAccountId);
    }
  } catch (cause) {
    accounts.value = null;
    error.value =
      cause instanceof ApiError && cause.status === 401
        ? t("browserAccountsUnavailable")
        : t("browserAccountsError");
  } finally {
    loading.value = false;
  }
}

function selectedAccount(account: BrowserAccount): boolean {
  return sessionState.user?.id === account.id && !sessionState.user.agentSession;
}

function selectedAgent(view: BrowserAgentView): boolean {
  return sessionState.user?.agentSession?.id === view.sessionId;
}

function agentExpiry(view: BrowserAgentView): string {
  if (view.expiresAt <= Date.now()) return t("browserAgentSessionExpired");
  return t("browserAgentSessionExpires", {
    date: new Date(view.expiresAt).toLocaleString(locale.value),
  });
}

async function selectAccount(account: BrowserAccount): Promise<void> {
  if (busy.value || selectedAccount(account)) return;
  busy.value = true;
  error.value = "";
  try {
    if (
      sessionState.user?.id === account.id ||
      (!sessionState.user && accounts.value?.activeAccountId === account.id)
    ) {
      await api.switchBrowserView({ kind: "account" });
    } else {
      await api.switchBrowserAccount(account.id);
    }
    emit("identity-switch", "/dashboard");
  } catch {
    error.value = t("browserAccountSwitchError");
  } finally {
    busy.value = false;
  }
}

async function selectAgent(view: BrowserAgentView): Promise<void> {
  if (busy.value || selectedAgent(view) || !sessionState.user) return;
  busy.value = true;
  error.value = "";
  try {
    await api.switchBrowserView({ kind: "agent", sessionId: view.sessionId });
    emit(
      "identity-switch",
      `/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repository)}`
    );
  } catch {
    error.value = t("browserAgentViewError");
  } finally {
    busy.value = false;
  }
}

async function removeAccount(account: BrowserAccount): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.removeBrowserAccount(account.id);
    if (result.isCurrent) {
      emit("identity-switch", "/login");
      return;
    }
    await loadAccounts();
  } catch {
    error.value = t("browserAccountRemoveError");
  } finally {
    busy.value = false;
  }
}

async function logoutAll(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.logoutAllBrowserAccounts();
    emit("identity-switch", "/login");
  } catch {
    error.value = t("browserAccountsError");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="browser-account-menu" :aria-label="t('browserAccounts')">
    <h3>{{ t("browserAccounts") }}</h3>
    <p v-if="loading" class="browser-account-state" role="status">{{ t("loading") }}</p>
    <div v-else-if="error" class="browser-account-load-error">
      <p class="browser-account-state browser-account-error" role="alert">{{ error }}</p>
      <button class="browser-account-action" :disabled="busy" @click="loadAccounts">
        {{ t("retry") }}
      </button>
      <button class="browser-account-action" @click="emit('add-account')">
        <AppIcon name="plus" :size="14" />{{ t("addBrowserAccount") }}
      </button>
    </div>
    <template v-else-if="accounts">
      <div v-if="accounts.accounts.length" class="browser-account-list">
        <div v-for="account in accounts.accounts" :key="account.id" class="browser-account-row">
          <button
            class="browser-account-option"
            :aria-pressed="selectedAccount(account)"
            :disabled="busy || selectedAccount(account)"
            @click="selectAccount(account)"
          >
            <span class="browser-account-copy">
              <strong>{{ account.displayName || account.identifier }}</strong>
              <span>{{ account.identifier }}</span>
            </span>
            <AppIcon v-if="selectedAccount(account)" name="check" :size="14" />
            <span
              v-else-if="!sessionState.user && account.id === accounts.activeAccountId"
              class="browser-account-status"
              >{{ t("reactivateAccount") }}</span
            >
          </button>
          <button
            class="browser-account-remove"
            :aria-label="t('removeBrowserAccount', { account: account.identifier })"
            :disabled="busy"
            @click="removeAccount(account)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
      </div>
      <p v-else class="browser-account-state">{{ t("noBrowserAccounts") }}</p>
      <button
        v-if="accounts.accounts.length < accounts.accountLimit"
        class="browser-account-action"
        @click="emit('add-account')"
      >
        <AppIcon name="plus" :size="14" />{{ t("addBrowserAccount") }}
      </button>
      <p v-else class="browser-account-state">
        {{ t("browserAccountLimit", { limit: accounts.accountLimit }) }}
      </p>

      <div v-if="accounts.agentViews.length" class="browser-agent-views">
        <h3>{{ t("agentViews") }}</h3>
        <button
          v-for="view in accounts.agentViews"
          :key="view.sessionId"
          class="browser-account-option browser-agent-option"
          :aria-pressed="selectedAgent(view)"
          :disabled="
            busy || !sessionState.user || selectedAgent(view) || view.expiresAt <= Date.now()
          "
          @click="selectAgent(view)"
        >
          <span class="browser-account-copy">
            <strong
              >{{ view.agentName }} <span class="muted">@{{ view.agentHandle }}</span></strong
            >
            <span
              >{{ view.owner }}/{{ view.repository }} ·
              {{ t(view.permission === "write" ? "agentViewWrite" : "agentViewRead") }}</span
            >
            <span class="browser-agent-expiry">{{ agentExpiry(view) }}</span>
          </span>
          <AppIcon v-if="selectedAgent(view)" name="check" :size="14" />
        </button>
        <p v-if="accounts.agentViewsTruncated" class="browser-account-state">
          {{ t("agentViewsTruncated") }}
        </p>
      </div>
      <button
        v-if="accounts.accounts.length > 1"
        class="browser-account-action browser-account-logout-all"
        :disabled="busy"
        @click="logoutAll"
      >
        <AppIcon name="signOut" :size="14" />{{ t("signOutAllAccounts") }}
      </button>
    </template>
  </section>
</template>
