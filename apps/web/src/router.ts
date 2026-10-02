import { createRouter, createWebHistory } from "vue-router";
const AuthView = () => import("./pages/AuthView.vue");
const DashboardView = () => import("./pages/DashboardView.vue");
const RepositoryView = () => import("./pages/RepositoryView.vue");
const OrganizationsView = () => import("./pages/OrganizationsView.vue");
const OrganizationView = () => import("./pages/OrganizationView.vue");
const AccountSettingsView = () => import("./pages/AccountSettingsView.vue");
const AgentSettingsView = () => import("./pages/AgentSettingsView.vue");
import { refreshSession, sessionState } from "./lib/session";

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return to.path !== from.path ? { top: 0 } : false;
  },
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
    {
      path: "/:owner/:repo/tasks/:number([0-9]+)",
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
      path: "/:owner/:repo/:section(code|issues|pulls|discussions|wiki|tasks|commits|compare|settings|agents|deploy)?",
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
