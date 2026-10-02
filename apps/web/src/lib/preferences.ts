import { reactive, shallowRef } from "vue";
import type {
  AccountPreferences,
  AccountProfile,
} from "../../../../packages/contracts/src/account";
import { api } from "./api";
import { i18n } from "../i18n";
import { sessionState } from "./session";

export const preferencesState = reactive<AccountPreferences>({
  theme: "system",
  locale: "zh-CN",
  density: "comfortable",
  tabSize: 2,
  lineWrap: false,
});
export const accountProfileState = shallowRef<AccountProfile | null>(null);
let loadVersion = 0;
export function applyAccountPreferences(value: AccountPreferences): void {
  Object.assign(preferencesState, value);
  i18n.global.locale.value = value.locale;
  document.documentElement.lang = value.locale;
}
export async function loadAccountPreferences(): Promise<void> {
  const version = ++loadVersion;
  const userId = sessionState.user?.id;
  if (!userId) {
    accountProfileState.value = null;
    return;
  }
  try {
    const profile = await api.accountProfile();
    if (loadVersion === version && sessionState.user?.id === userId) {
      accountProfileState.value = profile;
      applyAccountPreferences(profile.preferences);
    }
  } catch {
    // Account settings reports errors; a failed preference read must not block navigation.
  }
}
