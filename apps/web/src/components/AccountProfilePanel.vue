<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  FluentButton,
  FluentField,
  FluentTextArea,
  FluentSelect,
  FluentSwitch,
} from "@platform-kit/fluent/vue";
import type { AccountProfile } from "../../../../packages/contracts/src/account";
import { api } from "../lib/api";
import { applyAccountPreferences, accountProfileState } from "../lib/preferences";
import { refreshSession } from "../lib/session";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";
const props = defineProps<{ section: "profile" | "preferences" }>();
const { t } = useI18n();
const profile = ref<AccountProfile | null>(null),
  initial = ref(""),
  error = ref(""),
  loading = ref(true),
  saving = ref(false),
  saved = ref(false);
const dirty = computed(
  () => profile.value !== null && JSON.stringify(profile.value) !== initial.value
);
const themeOptions = computed(() =>
  ["system", "light", "dark"].map((value) => ({
    value,
    label: t(
      value === "system"
        ? "settingsThemeSystem"
        : value === "light"
          ? "settingsThemeLight"
          : "settingsThemeDark"
    ),
  }))
);
const languageOptions = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];
const densityOptions = computed(() => [
  { value: "comfortable", label: t("settingsComfortable") },
  { value: "compact", label: t("settingsCompact") },
]);
const tabOptions = [2, 4, 8].map((value) => ({ value: String(value), label: String(value) }));
async function load() {
  loading.value = true;
  error.value = "";
  try {
    profile.value = await api.accountProfile();
    initial.value = JSON.stringify(profile.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("apiError");
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!profile.value) return;
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    profile.value = await api.updateAccountProfile(profile.value);
    initial.value = JSON.stringify(profile.value);
    accountProfileState.value = profile.value;
    applyAccountPreferences(profile.value.preferences);
    await refreshSession();
    saved.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("apiError");
  } finally {
    saving.value = false;
  }
}
function setTheme(value: string) {
  if (profile.value && (value === "system" || value === "light" || value === "dark"))
    profile.value.preferences.theme = value;
}
function setLocale(value: string) {
  if (profile.value && (value === "zh-CN" || value === "en"))
    profile.value.preferences.locale = value;
}
function setDensity(value: string) {
  if (profile.value && (value === "comfortable" || value === "compact"))
    profile.value.preferences.density = value;
}
function setTabSize(value: string) {
  const size = Number(value);
  if (profile.value && (size === 2 || size === 4 || size === 8))
    profile.value.preferences.tabSize = size;
}
onMounted(load);
</script>
<template>
  <section class="preference-panel">
    <h2 class="settings-page-title">
      {{ t(props.section === "profile" ? "settingsProfile" : "settingsPreferences") }}
    </h2>
    <p class="muted">
      {{
        t(
          props.section === "profile"
            ? "settingsProfileDescription"
            : "settingsPreferenceDescription"
        )
      }}
    </p>
    <StatusState v-if="loading" :loading="true" />
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <NoticeBar v-if="saved && !dirty" intent="success">{{ t("settingsSavedNotice") }}</NoticeBar>
    <form v-if="profile" class="settings-form-grid" @submit.prevent="save">
      <template v-if="section === 'profile'">
        <div class="settings-surface form-stack">
          <FluentField
            v-model="profile.identifier"
            :label="t('settingsUsername')"
            required
            minlength="3"
            maxlength="63"
            autocomplete="username"
          />
          <p class="muted">{{ t("settingsRenameNotice") }}</p>
          <FluentField
            v-model="profile.displayName"
            :label="t('settingsDisplayName')"
            required
            maxlength="100"
          />
          <FluentTextArea
            v-model="profile.bio"
            :label="t('settingsBio')"
            maxlength="500"
            rows="4"
          />
          <FluentField v-model="profile.location" :label="t('settingsLocation')" maxlength="100" />
          <FluentField
            v-model="profile.website"
            :label="t('settingsWebsite')"
            type="url"
            placeholder="https://"
            maxlength="255"
          />
        </div>
      </template>
      <template v-else>
        <div class="settings-surface form-stack">
          <FluentSelect
            :model-value="profile.preferences.theme"
            :label="t('settingsTheme')"
            :options="themeOptions"
            @update:model-value="setTheme"
          />
          <FluentSelect
            :model-value="profile.preferences.locale"
            :label="t('settingsLanguage')"
            :options="languageOptions"
            @update:model-value="setLocale"
          />
          <FluentSelect
            :model-value="profile.preferences.density"
            :label="t('settingsDensity')"
            :options="densityOptions"
            @update:model-value="setDensity"
          />
        </div>
        <div class="settings-surface form-stack">
          <FluentSelect
            :model-value="String(profile.preferences.tabSize)"
            :label="t('settingsTabSize')"
            :options="tabOptions"
            @update:model-value="setTabSize"
          />
          <div class="preference-row">
            <div>
              <strong>{{ t("settingsLineWrap") }}</strong>
              <p class="muted">{{ t("settingsLineWrapHint") }}</p>
            </div>
            <FluentSwitch
              v-model="profile.preferences.lineWrap"
              :aria-label="t('settingsLineWrap')"
            />
          </div>
        </div>
      </template>
      <div class="settings-actions">
        <FluentButton type="submit" tone="primary" :busy="saving" :disabled="!dirty">{{
          t("save")
        }}</FluentButton>
      </div>
    </form>
  </section>
</template>
