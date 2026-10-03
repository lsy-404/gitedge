import { reactive, ref, shallowRef } from "vue";
import type {
  AccountPreferences,
  AccountProfile,
} from "../../../../packages/contracts/src/account";
import {
  AccountPreferencesSchema,
  DefaultAccountPreferences,
} from "../../../../packages/contracts/src/account";
import { api } from "./api";
import { i18n } from "../i18n";
import { sessionState } from "./session";

const storageKey = "gitedge.preferences";
const defaults: AccountPreferences = { ...DefaultAccountPreferences };
function readLocalPreferences(): AccountPreferences {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return defaults;
    const parsed = AccountPreferencesSchema.partial().safeParse(JSON.parse(stored));
    return parsed.success ? { ...defaults, ...parsed.data } : defaults;
  } catch {
    return defaults;
  }
}
function saveLocalPreferences(): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferencesState));
  } catch {
    // Private browsing or storage policy can disable local persistence.
  }
}

export const preferencesState = reactive<AccountPreferences>(readLocalPreferences());
export const preferenceError = ref("");
export const preferenceSaving = ref(false);
export const accountProfileState = shallowRef<AccountProfile | null>(null);
let loadVersion = 0;

function apply(value: AccountPreferences): void {
  Object.assign(preferencesState, value);
  i18n.global.locale.value = value.locale;
  document.documentElement.lang = value.locale;
  saveLocalPreferences();
}

apply(readLocalPreferences());

export function applyAccountPreferences(value: AccountPreferences): void {
  apply(value);
}

export async function updatePreference(
  key: "locale" | "theme",
  value: AccountPreferences["locale"] | AccountPreferences["theme"]
): Promise<void> {
  if (preferenceSaving.value) return;
  loadVersion += 1;
  const previous = preferencesState[key];
  if (previous === value && (!sessionState.user || accountProfileState.value)) return;
  preferenceError.value = "";
  apply({ ...preferencesState, [key]: value });
  const userId = sessionState.user?.id;
  if (!userId || sessionState.user?.agentSession) return;
  preferenceSaving.value = true;
  try {
    const profile = await api.updateAccountProfile({ preferences: { [key]: value } });
    if (sessionState.user?.id === userId) accountProfileState.value = profile;
  } catch {
    if (sessionState.user?.id === userId && preferencesState[key] === value) {
      apply({ ...preferencesState, [key]: previous });
      preferenceError.value = i18n.global.t("avatarPreferenceSaveError");
    }
  } finally {
    preferenceSaving.value = false;
  }
}

export async function loadAccountPreferences(): Promise<void> {
  const version = ++loadVersion;
  const userId = sessionState.user?.id;
  preferenceError.value = "";
  if (sessionState.user?.agentSession) {
    accountProfileState.value = null;
    return;
  }
  if (!userId) {
    accountProfileState.value = null;
    apply(readLocalPreferences());
    return;
  }
  accountProfileState.value = null;
  apply(readLocalPreferences());
  try {
    const profile = await api.accountProfile();
    if (loadVersion === version && sessionState.user?.id === userId) {
      accountProfileState.value = profile;
      apply(profile.preferences);
    }
  } catch {
    // Account settings reports errors; a failed preference read must not block navigation.
  }
}
