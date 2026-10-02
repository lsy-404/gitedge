import { createRouter, createWebHistory } from "vue-router";
import AuthView from "./pages/AuthView.vue";
import DashboardView from "./pages/DashboardView.vue";
import RepositoryView from "./pages/RepositoryView.vue";
import OrganizationsView from "./pages/OrganizationsView.vue";
import OrganizationView from "./pages/OrganizationView.vue";
import AccountSettingsView from "./pages/AccountSettingsView.vue";
import AgentSettingsView from "./pages/AgentSettingsView.vue";
import { refreshSession, sessionState } from "./lib/session";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/login", component: AuthView, meta: { public: true } },
    { path: "/register", component: AuthView, meta: { public: true } },
    { path: "/dashboard", component: DashboardView },
    { path: "/organizations", component: OrganizationsView },
    { path: "/organizations/:slug", component: OrganizationView },
    { path: "/settings/account", component: AccountSettingsView },
    { path: "/settings/agents", component: AgentSettingsView },
    {
      path: "/:owner/:repo/issues/:number([0-9]+)",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    {
      path: "/:owner/:repo/pulls/:number([0-9]+)",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    {
      path: "/:owner/:repo/discussions/:number([0-9]+)",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    { path: "/:owner/:repo/wiki/:slug", component: RepositoryView, meta: { allowAnonymous: true } },
    {
      path: "/:owner/:repo/:view(tree|blob)/:path(.*)*",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    {
      path: "/:owner/:repo/:section(code|issues|pulls|discussions|wiki|commits|compare|settings|agents|deploy)?",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
  ],
});

router.beforeEach(async (to) => {
  if (!sessionState.checked) await refreshSession();
  if (!to.meta.public && !to.meta.allowAnonymous && !sessionState.user) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  if ((to.path === "/login" || to.path === "/register") && sessionState.user) return "/dashboard";
});
