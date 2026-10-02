<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "./components/AppIcon.vue";
import { api } from "./lib/api";
import { clearSession, refreshSession, sessionState } from "./lib/session";
import { preferencesState, loadAccountPreferences } from "./lib/preferences";
const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const accountName = computed(
  () => sessionState.user?.externalIdentity?.login || sessionState.user?.identifier || ""
);
const initials = computed(() => accountName.value.slice(0, 2).toUpperCase());
const authPage = computed(() => route.path === "/login" || route.path === "/register");
const repositoryPath = computed(() =>
  route.params.owner && route.params.repo ? `/${route.params.owner}/${route.params.repo}` : ""
);
const pageName = computed(() =>
  route.path.startsWith("/settings")
    ? t("account")
    : route.path.startsWith("/organizations")
      ? t("organizations")
      : t("dashboard")
);
const search = ref("");
const searchExpanded = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const navigation = ref<HTMLDialogElement | null>(null);
const userMenu = ref<HTMLDetailsElement | null>(null);
const createMenu = ref<HTMLDetailsElement | null>(null);
async function openSearch() {
  searchExpanded.value = true;
  await nextTick();
  searchInput.value?.focus();
}
function closeMenus() {
  searchExpanded.value = false;
  if (navigation.value?.open) navigation.value.close();
  if (userMenu.value) userMenu.value.open = false;
  if (createMenu.value) createMenu.value.open = false;
}
function toggleLocale() {
  locale.value = locale.value === "zh-CN" ? "en" : "zh-CN";
}
function submitSearch() {
  const query = search.value.trim();
  if (/^[a-z\d_-]+\/[a-z\d_.-]+$/i.test(query)) void router.push(`/${query}`);
  else void router.push({ path: "/dashboard", query: query ? { q: query } : {} });
  searchInput.value?.blur();
}
function keyboard(event: KeyboardEvent) {
  if (event.key === "Escape") closeMenus();
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
async function signOut() {
  await api.logout();
  clearSession();
  closeMenus();
  await router.push("/login");
}
watch(() => route.fullPath, closeMenus);
watch(locale, (value) => {
  document.documentElement.lang = value;
});
watch(
  () => sessionState.user?.id,
  (userId) => {
    if (userId) void loadAccountPreferences();
  },
  { immediate: true }
);
onMounted(() => document.addEventListener("keydown", keyboard));
onUnmounted(() => document.removeEventListener("keydown", keyboard));
if (!sessionState.checked) void refreshSession();
</script>
<template>
  <FluentTheme
    :mode="preferencesState.theme"
    accent="#f6821f"
    accent-text="#1a0e04"
    :data-density="preferencesState.density"
  >
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
          <RouterLink class="brand" to="/dashboard" :aria-label="t('brand')"
            ><img src="/logo.svg" alt="" width="32" height="32" /><span v-if="authPage"
              >GitEdge</span
            ></RouterLink
          >
          <nav v-if="!authPage" class="header-context" :aria-label="t('ghBreadcrumbs')">
            <template v-if="repositoryPath"
              ><span>{{ route.params.owner }}</span
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
            <button
              class="btn btn-subtle locale-button"
              @click="toggleLocale"
              :aria-label="t('ghLanguage')"
            >
              {{ locale === "zh-CN" ? "EN" : "中文" }}
            </button>
            <template v-if="sessionState.user && !authPage">
              <details ref="createMenu" class="dropdown create-menu">
                <summary class="btn" :aria-label="t('ghCreate')">
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
              <RouterLink
                v-if="repositoryPath"
                class="btn icon-button quick-action"
                :to="`${repositoryPath}/issues`"
                :aria-label="t('issues')"
                ><AppIcon name="issue"
              /></RouterLink>
              <RouterLink
                v-if="repositoryPath"
                class="btn icon-button quick-action"
                :to="`${repositoryPath}/pulls`"
                :aria-label="t('pulls')"
                ><AppIcon name="pr"
              /></RouterLink>
              <details ref="userMenu" class="dropdown user-menu">
                <summary :aria-label="t('ghUserMenu')" class="account-trigger">
                  <span class="avatar"
                    ><img
                      v-if="sessionState.user.externalIdentity?.avatarUrl"
                      :src="sessionState.user.externalIdentity.avatarUrl"
                      alt=""
                    /><span v-else>{{ initials }}</span></span
                  >
                </summary>
                <div class="dropdown-panel">
                  <p class="dropdown-identity">
                    {{ t("ghSignedIn") }}<strong>{{ accountName }}</strong>
                  </p>
                  <hr />
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
                  <button @click="signOut"><AppIcon name="signOut" />{{ t("signOut") }}</button>
                </div>
              </details>
            </template>
            <RouterLink
              v-else-if="!authPage"
              class="btn"
              :to="{ path: '/login', query: { redirect: route.fullPath } }"
              >{{ t("signIn") }}</RouterLink
            >
          </div>
        </div>
        <nav v-if="!authPage && !repositoryPath" class="global-nav" :aria-label="t('mainNav')">
          <RouterLink to="/dashboard"><AppIcon name="repo" />{{ t("repositories") }}</RouterLink
          ><RouterLink to="/organizations"
            ><AppIcon name="organization" />{{ t("organizations") }}</RouterLink
          ><RouterLink to="/settings/agents"><AppIcon name="agent" />{{ t("agents") }}</RouterLink>
        </nav>
      </header>
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
          <RouterLink to="/dashboard"><AppIcon name="home" />{{ t("dashboard") }}</RouterLink
          ><RouterLink to="/dashboard"><AppIcon name="repo" />{{ t("repositories") }}</RouterLink
          ><RouterLink to="/organizations"
            ><AppIcon name="organization" />{{ t("organizations") }}</RouterLink
          ><RouterLink to="/settings/agents"><AppIcon name="agent" />{{ t("agents") }}</RouterLink>
          <hr />
          <RouterLink to="/settings/account"><AppIcon name="gear" />{{ t("account") }}</RouterLink>
        </nav>
        <p class="drawer-footer">{{ t("edge") }}</p>
      </dialog>
      <main id="main" tabindex="-1"><RouterView /></main>
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
