import { createRouter, createWebHistory } from "vue-router";
const AuthView = () => import("./pages/AuthView.vue");
const ForgotPasswordView = () => import("./pages/ForgotPasswordView.vue");
const ResetPasswordView = () => import("./pages/ResetPasswordView.vue");
const VerifyEmailView = () => import("./pages/VerifyEmailView.vue");
const DashboardView = () => import("./pages/DashboardView.vue");
const RepositoryView = () => import("./pages/RepositoryView.vue");
const OrganizationsView = () => import("./pages/OrganizationsView.vue");
const OrganizationView = () => import("./pages/OrganizationView.vue");
const AccountSettingsView = () => import("./pages/AccountSettingsView.vue");
const AgentSettingsView = () => import("./pages/AgentSettingsView.vue");
const AgentProfileView = () => import("./pages/AgentProfileView.vue");
const AgentWebhookSettings = () => import("./pages/AgentWebhookSettings.vue");
const InviteAcceptView = () => import("./pages/InviteAcceptView.vue");
const AdminView = () => import("./pages/AdminView.vue");
const UserProfileView = () => import("./pages/UserProfileView.vue");
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
    { path: "/forgot-password", component: ForgotPasswordView, meta: { public: true } },
    { path: "/reset-password", component: ResetPasswordView, meta: { public: true } },
    { path: "/verify-email", component: VerifyEmailView, meta: { public: true } },
    { path: "/invite", component: InviteAcceptView, meta: { allowAnonymous: true } },
    { path: "/admin", component: AdminView },
    { path: "/dashboard", component: DashboardView },
    { path: "/organizations", component: OrganizationsView },
    { path: "/organizations/:slug", component: OrganizationView },
    { path: "/settings/account", component: AccountSettingsView },
    { path: "/settings/agents", component: AgentSettingsView },
    { path: "/settings/agents/:id", component: AgentWebhookSettings },
    { path: "/settings/agents/:id/webhook", component: AgentWebhookSettings },
    { path: "/:owner/@:handle", component: AgentProfileView, meta: { allowAnonymous: true } },
    { path: "/:owner", component: UserProfileView, props: true, meta: { allowAnonymous: true } },
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
      path: "/:owner/:repo/:section(code|issues|pulls|discussions|wiki|tasks|commits|compare|settings|agents|deploy|actions)?",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
  ],
});

router.beforeEach(async (to, from) => {
  if (!sessionState.checked) await refreshSession();
  if (!to.meta.public && !to.meta.allowAnonymous && !sessionState.user) {
    if (sessionState.view === "guest" && from.matched.length) return false;
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  if ((to.path === "/login" || to.path === "/register") && sessionState.user) {
    if (to.path === "/login" && to.query.add === "1") return;
    return "/dashboard";
  }
});
