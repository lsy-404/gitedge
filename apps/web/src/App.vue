<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "./components/AppIcon.vue";
import BrowserAccountMenu from "./components/BrowserAccountMenu.vue";
import { api } from "./lib/api";
import { clearSession, refreshSession, sessionState } from "./lib/session";
import {
  listenForBrowserIdentityChanges,
  notifyBrowserIdentityChanged,
} from "./lib/browserIdentity";
import {
  preferencesState,
  loadAccountPreferences,
  accountProfileState,
  updatePreference,
  preferenceError,
  preferenceSaving,
} from "./lib/preferences";
const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const accountName = computed(
  () =>
    accountProfileState.value?.displayName ||
    sessionState.user?.externalIdentity?.login ||
    sessionState.user?.identifier ||
    ""
);
const initials = computed(() => accountName.value.slice(0, 2).toUpperCase());
const authPage = computed(() => route.path === "/login" || route.path === "/register");
const repositoryPath = computed(() =>
  route.params.owner && route.params.repo ? `/${route.params.owner}/${route.params.repo}` : ""
);
const pageName = computed(() => {
  if (authPage.value) return route.path === "/register" ? t("registerTitle") : t("signIn");
  if (route.params.owner && route.params.repo) return `${route.params.owner}/${route.params.repo}`;
  if (route.params.handle) return t("agentProfile");
  if (route.params.owner && !route.params.repo) return String(route.params.owner);
  if (route.path.startsWith("/settings/agents")) return t("agents");
  if (route.path.startsWith("/settings")) return t("account");
  if (route.path.startsWith("/organizations")) return t("organizations");
  return t("dashboard");
});
const mainRegion = ref<HTMLElement | null>(null);
watchEffect(() => {
  document.title = `${pageName.value} · GitEdge`;
});
watch(
  () => route.path,
  async (path, previous) => {
    if (path === previous) return;
    await nextTick();
    mainRegion.value?.focus({ preventScroll: true });
  }
);
const search = ref("");
const searchExpanded = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const navigation = ref<HTMLDialogElement | null>(null);
const userMenu = ref<HTMLDetailsElement | null>(null);
const userMenuOpen = ref(false);
const createMenu = ref<HTMLDetailsElement | null>(null);
const createMenuOpen = ref(false);
const expandedPreference = ref<"language" | "theme" | null>(null);
const guestView = computed(() => sessionState.view === "guest");
const identitySwitchError = ref("");
async function openSearch() {
  searchExpanded.value = true;
  await nextTick();
  searchInput.value?.focus();
}
function closeMenus() {
  searchExpanded.value = false;
  if (navigation.value?.open) navigation.value.close();
  if (userMenu.value) userMenu.value.open = false;
  userMenuOpen.value = false;
  if (createMenu.value) createMenu.value.open = false;
  createMenuOpen.value = false;
}
function headerMenus(): HTMLDetailsElement[] {
  return [createMenu.value, userMenu.value].filter(
    (menu): menu is HTMLDetailsElement => menu !== null
  );
}
function dismissHeaderMenus(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const menu of headerMenus()) if (menu.open && !menu.contains(target)) menu.open = false;
}
function onMenuFocusOut(event: FocusEvent) {
  const menu = event.currentTarget;
  if (!(menu instanceof HTMLDetailsElement)) return;
  if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget)) menu.open = false;
}
function onMenuToggle(event: Event) {
  const menu = event.currentTarget;
  if (!(menu instanceof HTMLDetailsElement)) return;
  if (menu === userMenu.value) userMenuOpen.value = menu.open;
  if (menu === createMenu.value) createMenuOpen.value = menu.open;
  if (menu.open) for (const other of headerMenus()) if (other !== menu) other.open = false;
}
async function setPreference(
  key: "locale" | "theme",
  value: "zh-CN" | "en" | "system" | "light" | "dark"
) {
  if (key === "locale" && value !== "zh-CN" && value !== "en") return;
  if (key === "theme" && value !== "system" && value !== "light" && value !== "dark") return;
  await updatePreference(key, value);
}
function submitSearch() {
  const query = search.value.trim();
  if (/^[a-z\d_-]+\/[a-z\d_.-]+$/i.test(query)) void router.push(`/${query}`);
  else void router.push({ path: "/dashboard", query: query ? { q: query } : {} });
  searchInput.value?.blur();
}
function keyboard(event: KeyboardEvent) {
  if (event.key === "Escape") {
    const openMenu = userMenu.value?.open
      ? userMenu.value
      : createMenu.value?.open
        ? createMenu.value
        : null;
    const trigger = openMenu?.querySelector<HTMLElement>("summary");
    closeMenus();
    trigger?.focus();
  }
  if (
    event.key === "/" &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.target instanceof HTMLElement &&
    !event.target.closest("input, textarea, [contenteditable]")
  ) {
    event.preventDefault();
    void openSearch();
  }
}
const signingOut = ref(false);
async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  identitySwitchError.value = "";
  try {
    await api.logout();
  } catch {
    identitySwitchError.value = t("signOutError");
    return;
  } finally {
    signingOut.value = false;
  }
  notifyBrowserIdentityChanged();
  clearSession();
  closeMenus();
  await router.push("/login");
}
function addBrowserAccount() {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : route.fullPath;
  void router.push({ path: "/login", query: { add: "1", redirect } });
}
let identityNavigating = false;
function completeIdentitySwitch(target: string) {
  identityNavigating = true;
  notifyBrowserIdentityChanged();
  if (target === "/login") clearSession();
  window.location.assign(target);
}
async function returnToAccountView() {
  identitySwitchError.value = "";
  try {
    await api.switchBrowserView({ kind: "account" });
    completeIdentitySwitch(route.meta.allowAnonymous ? route.fullPath : "/dashboard");
  } catch {
    identitySwitchError.value = t("returnToAccountViewError");
  }
}
async function previewAsGuest() {
  if (!sessionState.user) return;
  const target = route.meta.allowAnonymous ? route.fullPath : `/${sessionState.user.identifier}`;
  identitySwitchError.value = "";
  try {
    await api.switchBrowserView({ kind: "guest" });
    completeIdentitySwitch(target);
  } catch {
    identitySwitchError.value = t("guestViewError");
  }
}
let stopIdentityListener: () => void = () => undefined;
let identityRefreshInFlight: Promise<void> | null = null;
function identityKey(): string {
  const user = sessionState.user;
  return `${user?.id ?? ""}:${sessionState.view}`;
}
function refreshIdentityOnReturn(): Promise<void> {
  if (identityNavigating) return Promise.resolve();
  if (identityRefreshInFlight) return identityRefreshInFlight;
  const previousIdentity = identityKey();
  identityRefreshInFlight = refreshSession()
    .then(() => {
      if (!identityNavigating && previousIdentity !== identityKey()) window.location.reload();
    })
    .finally(() => {
      identityRefreshInFlight = null;
    });
  return identityRefreshInFlight;
}
function refreshIdentityWhenVisible() {
  if (document.visibilityState === "visible") void refreshIdentityOnReturn();
}
function refreshIdentityOnFocus() {
  void refreshIdentityOnReturn();
}
watch(() => route.fullPath, closeMenus);
watch(locale, (value) => {
  document.documentElement.lang = value;
});
watch(
  () => sessionState.user?.id,
  () => {
    void loadAccountPreferences();
  },
  { immediate: true }
);
onMounted(() => {
  document.addEventListener("keydown", keyboard);
  document.addEventListener("pointerdown", dismissHeaderMenus);
  stopIdentityListener = listenForBrowserIdentityChanges(() => void refreshIdentityOnReturn());
  window.addEventListener("focus", refreshIdentityOnFocus);
  document.addEventListener("visibilitychange", refreshIdentityWhenVisible);
});
onUnmounted(() => {
  document.removeEventListener("keydown", keyboard);
  document.removeEventListener("pointerdown", dismissHeaderMenus);
  window.removeEventListener("focus", refreshIdentityOnFocus);
  document.removeEventListener("visibilitychange", refreshIdentityWhenVisible);
  stopIdentityListener();
});
if (!sessionState.checked) void refreshSession();
</script>
<template>
  <FluentTheme :mode="preferencesState.theme" :data-density="preferencesState.density">
    <div class="app-shell">
      <a class="skip-link" href="#main">{{ t("skipToContent") }}</a>
      <header class="site-header" :class="{ 'site-header-auth': authPage }">
        <div class="global-bar">
          <button
            v-if="!authPage"
            class="btn icon-button nav-toggle"
            :aria-label="t('ghNavigation')"
            @click="navigation?.showModal()"
          >
            <AppIcon name="menu" />
          </button>
          <RouterLink
            class="brand"
            :to="guestView ? route.fullPath : '/dashboard'"
            :aria-label="t('brand')"
            ><img src="/logo.svg" alt="" width="32" height="32" /><span v-if="authPage"
              >GitEdge</span
            ></RouterLink
          >
          <nav v-if="!authPage" class="header-context" :aria-label="t('ghBreadcrumbs')">
            <template v-if="repositoryPath"
              ><RouterLink :to="`/${route.params.owner}`">{{ route.params.owner }}</RouterLink
              ><span class="muted">/</span
              ><RouterLink :to="repositoryPath">{{ route.params.repo }}</RouterLink></template
            >
            <strong v-else>{{ pageName }}</strong>
          </nav>
          <form
            v-if="!authPage"
            class="global-search"
            :class="{ 'search-expanded': searchExpanded }"
            role="search"
            @submit.prevent="submitSearch"
          >
            <AppIcon name="search" /><input
              ref="searchInput"
              v-model="search"
              :placeholder="t('ghSearch')"
              :aria-label="t('ghSearch')"
            /><kbd>/</kbd>
          </form>
          <button
            v-if="!authPage"
            class="btn icon-button mobile-search"
            :aria-label="t('ghSearch')"
            @click="openSearch"
          >
            <AppIcon name="search" />
          </button>
          <div class="global-actions">
            <template v-if="sessionState.user && !guestView && !authPage">
              <details
                ref="createMenu"
                class="dropdown create-menu"
                @toggle="onMenuToggle"
                @focusout="onMenuFocusOut"
              >
                <summary class="btn" :aria-label="t('ghCreate')" :aria-expanded="createMenuOpen">
                  <AppIcon name="plus" /><AppIcon name="chevron" :size="12" />
                </summary>
                <div class="dropdown-panel">
                  <RouterLink to="/dashboard?new=1"
                    ><AppIcon name="repo" />{{ t("newRepo") }}</RouterLink
                  ><RouterLink to="/organizations?new=1"
                    ><AppIcon name="organization" />{{ t("ghNewOrganization") }}</RouterLink
                  ><RouterLink to="/settings/agents?new=1"
                    ><AppIcon name="agent" />{{ t("ghNewAgent") }}</RouterLink
                  >
                </div>
              </details>
            </template>
            <details
              ref="userMenu"
              class="dropdown user-menu"
              @toggle="onMenuToggle"
              @focusout="onMenuFocusOut"
            >
              <summary
                :aria-label="t('ghUserMenu')"
                class="account-trigger"
                :aria-expanded="userMenuOpen"
              >
                <span v-if="sessionState.user" class="avatar"
                  ><img
                    v-if="sessionState.user.externalIdentity?.avatarUrl"
                    :src="sessionState.user.externalIdentity.avatarUrl"
                    alt=""
                  /><span v-else>{{ initials }}</span></span
                ><span v-else class="avatar"><AppIcon name="person" /></span>
              </summary>
              <div class="dropdown-panel browser-account-dropdown">
                <p v-if="sessionState.user && !guestView" class="dropdown-identity">
                  {{ t("ghSignedIn")
                  }}<RouterLink :to="`/${sessionState.user.identifier}`"
                    ><strong>{{ accountName }}</strong></RouterLink
                  >
                </p>
                <BrowserAccountMenu
                  v-if="userMenuOpen"
                  @identity-switch="completeIdentitySwitch"
                  @add-account="addBrowserAccount"
                  @guest-preview="previewAsGuest"
                />
                <hr />
                <template v-if="sessionState.user && !guestView">
                  <RouterLink to="/dashboard"
                    ><AppIcon name="repo" />{{ t("repositories") }}</RouterLink
                  ><RouterLink to="/organizations"
                    ><AppIcon name="organization" />{{ t("organizations") }}</RouterLink
                  ><RouterLink to="/settings/agents"
                    ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
                  ><RouterLink to="/settings/account"
                    ><AppIcon name="gear" />{{ t("account") }}</RouterLink
                  >
                  <hr />
                </template>
                <p v-if="identitySwitchError && !guestView" class="preference-error" role="alert">
                  {{ identitySwitchError }}
                </p>
                <p v-if="preferenceError" class="preference-error" role="alert">
                  {{ preferenceError }}
                </p>
                <button
                  class="preference-group-toggle"
                  :aria-expanded="expandedPreference === 'language'"
                  @click="
                    expandedPreference = expandedPreference === 'language' ? null : 'language'
                  "
                >
                  {{ t("avatarLanguage")
                  }}<span>{{ locale === "zh-CN" ? "简体中文" : "English" }}</span>
                </button>
                <div
                  v-if="expandedPreference === 'language'"
                  class="preference-options"
                  role="group"
                  :aria-label="t('avatarLanguage')"
                >
                  <button
                    v-for="option in ['zh-CN', 'en']"
                    :key="option"
                    :lang="option"
                    :disabled="preferenceSaving"
                    :aria-pressed="locale === option"
                    @click="setPreference('locale', option)"
                  >
                    {{ option === "zh-CN" ? "简体中文" : "English"
                    }}<AppIcon v-if="locale === option" name="check" :size="14" />
                  </button>
                </div>
                <button
                  class="preference-group-toggle"
                  :aria-expanded="expandedPreference === 'theme'"
                  @click="expandedPreference = expandedPreference === 'theme' ? null : 'theme'"
                >
                  {{ t("avatarTheme")
                  }}<span>{{
                    t(
                      preferencesState.theme === "system"
                        ? "settingsThemeSystem"
                        : preferencesState.theme === "light"
                          ? "settingsThemeLight"
                          : "settingsThemeDark"
                    )
                  }}</span>
                </button>
                <div
                  v-if="expandedPreference === 'theme'"
                  class="preference-options"
                  role="group"
                  :aria-label="t('avatarTheme')"
                >
                  <button
                    v-for="option in ['system', 'light', 'dark']"
                    :key="option"
                    :disabled="preferenceSaving"
                    :aria-pressed="preferencesState.theme === option"
                    @click="setPreference('theme', option)"
                  >
                    {{
                      t(
                        option === "system"
                          ? "settingsThemeSystem"
                          : option === "light"
                            ? "settingsThemeLight"
                            : "settingsThemeDark"
                      )
                    }}<AppIcon v-if="preferencesState.theme === option" name="check" :size="14" />
                  </button>
                </div>
                <hr />
                <button v-if="sessionState.user" :disabled="signingOut" @click="signOut">
                  <AppIcon name="signOut" />{{ t("signOut") }}
                </button>
                <RouterLink
                  v-else-if="!authPage"
                  class="btn"
                  :to="{ path: '/login', query: { redirect: route.fullPath } }"
                  >{{ t("signIn") }}</RouterLink
                >
              </div>
            </details>
          </div>
        </div>
        <nav
          v-if="!authPage && !repositoryPath && !guestView"
          class="global-nav"
          :aria-label="t('mainNav')"
        >
          <RouterLink to="/dashboard"><AppIcon name="repo" />{{ t("repositories") }}</RouterLink
          ><RouterLink to="/organizations"
            ><AppIcon name="organization" />{{ t("organizations") }}</RouterLink
          ><RouterLink v-if="!guestView" to="/settings/agents"
            ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
          >
        </nav>
      </header>
      <div v-if="guestView" class="guest-view-banner" role="status">
        <span class="guest-view-banner-copy"
          ><AppIcon name="eye" :size="16" />{{ t("guestViewBanner") }}</span
        >
        <span>
          <span v-if="identitySwitchError" class="guest-view-banner-error" role="alert">{{
            identitySwitchError
          }}</span>
          <button class="btn btn-subtle" @click="returnToAccountView">
            {{ t("returnToAccountView") }}
          </button>
        </span>
      </div>
      <dialog
        ref="navigation"
        class="navigation-drawer"
        @click="$event.target === navigation && navigation?.close()"
      >
        <div class="drawer-title">
          <img src="/logo.svg" alt="" width="32" height="32" /><strong>GitEdge</strong
          ><button
            class="btn btn-subtle icon-button"
            :aria-label="t('close')"
            @click="navigation?.close()"
          >
            <AppIcon name="close" />
          </button>
        </div>
        <nav :aria-label="t('mainNav')">
          <RouterLink v-if="!guestView" to="/dashboard"
            ><AppIcon name="home" />{{ t("dashboard") }}</RouterLink
          ><RouterLink v-if="!guestView" to="/dashboard"
            ><AppIcon name="repo" />{{ t("repositories") }}</RouterLink
          ><RouterLink v-if="!guestView" to="/organizations"
            ><AppIcon name="organization" />{{ t("organizations") }}</RouterLink
          ><RouterLink v-if="!guestView" to="/settings/agents"
            ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
          >
          <hr />
          <RouterLink v-if="!guestView" to="/settings/account"
            ><AppIcon name="gear" />{{ t("account") }}</RouterLink
          >
        </nav>
        <p class="drawer-footer">{{ t("edge") }}</p>
      </dialog>
      <main id="main" ref="mainRegion" tabindex="-1"><RouterView /></main>
      <footer class="site-footer">
        <img src="/logo.svg" alt="" width="20" height="20" /><span>GitEdge</span
        ><span>{{ t("edge") }}</span
        ><a href="https://github.com/lsy-404/gitedge" target="_blank" rel="noreferrer">{{
          t("ghSource")
        }}</a
        ><span>MIT</span>
      </footer>
    </div>
  </FluentTheme>
</template>
