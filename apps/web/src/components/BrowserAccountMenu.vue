<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  BrowserAccount,
  BrowserAccounts,
} from "../../../../packages/contracts/src/browser-accounts";
import AppIcon from "./AppIcon.vue";
import { ApiError, api } from "../lib/api";
import { sessionState } from "../lib/session";

const emit = defineEmits<{
  "identity-switch": [target: string];
  "add-account": [];
  "guest-preview": [];
}>();
const { t } = useI18n();
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
  return sessionState.user?.id === account.id && sessionState.view === "account";
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

function selectGuestView(): void {
  if (!busy.value && sessionState.view !== "guest") emit("guest-preview");
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
  <section class="browser-account-menu" aria-labelledby="browser-accounts-title">
    <p id="browser-accounts-title" class="browser-account-heading">{{ t("browserAccounts") }}</p>
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
      <ul v-if="accounts.accounts.length" class="browser-account-list">
        <li v-for="account in accounts.accounts" :key="account.id" class="browser-account-row">
          <button
            class="browser-account-option"
            :aria-pressed="selectedAccount(account)"
            :disabled="busy"
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
        </li>
      </ul>
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

      <div
        v-if="accounts.activeAccountId || sessionState.view === 'guest'"
        class="browser-view-options"
        role="group"
        aria-labelledby="browser-views-title"
      >
        <p id="browser-views-title" class="browser-account-heading">{{ t("browserViews") }}</p>
        <button
          class="browser-account-option"
          :aria-pressed="sessionState.view === 'guest'"
          :disabled="busy"
          @click="selectGuestView"
        >
          <AppIcon name="eye" :size="16" />{{ t("guestView") }}
          <AppIcon v-if="sessionState.view === 'guest'" name="check" :size="14" />
        </button>
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
