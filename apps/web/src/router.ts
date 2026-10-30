import { createRouter, createWebHistory } from "vue-router";
const LandingView = () => import("./pages/LandingView.vue");
const NotFoundView = () => import("./pages/NotFoundView.vue");
const GitAuthorizeView = () => import("./pages/GitAuthorizeView.vue");
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
const NotificationsView = () => import("./pages/NotificationsView.vue");
const UserProfileView = () => import("./pages/UserProfileView.vue");
const ExploreView = () => import("./pages/ExploreView.vue");
const StarredView = () => import("./pages/StarredView.vue");
const ApiDocsView = () => import("./pages/ApiDocsView.vue");
import { refreshSession, sessionState } from "./lib/session";

declare module "vue-router" {
  interface RouteMeta {
    public?: boolean;
    allowAnonymous?: boolean;
    landing?: boolean;
    /** i18n key for the header label and document title of static routes. */
    title?: string;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return to.path !== from.path ? { top: 0 } : false;
  },
  routes: [
    {
      path: "/",
      component: LandingView,
      meta: { allowAnonymous: true, landing: true, title: "landingTitle" },
    },
    { path: "/login", component: AuthView, meta: { public: true, title: "signIn" } },
    { path: "/register", component: AuthView, meta: { public: true, title: "registerTitle" } },
    {
      path: "/forgot-password",
      component: ForgotPasswordView,
      meta: { public: true, title: "forgotPasswordTitle" },
    },
    {
      path: "/reset-password",
      component: ResetPasswordView,
      meta: { public: true, title: "resetPasswordTitle" },
    },
    {
      path: "/verify-email",
      component: VerifyEmailView,
      meta: { public: true, title: "verifyEmailTitle" },
    },
    {
      path: "/invite",
      component: InviteAcceptView,
      meta: { allowAnonymous: true, title: "inviteTitle" },
    },
    { path: "/git/authorize", component: GitAuthorizeView, meta: { title: "gitAuthorizeTitle" } },
    { path: "/admin", component: AdminView, meta: { title: "adminTitle" } },
    { path: "/dashboard", component: DashboardView, meta: { title: "dashboard" } },
    { path: "/notifications", component: NotificationsView, meta: { title: "notifications" } },
    {
      path: "/explore",
      component: ExploreView,
      meta: { allowAnonymous: true, title: "exploreNav" },
    },
    { path: "/stars", component: StarredView, meta: { title: "starredNav" } },
    {
      path: "/docs/api",
      component: ApiDocsView,
      meta: { allowAnonymous: true, title: "apiDocsTitle" },
    },
    { path: "/organizations", component: OrganizationsView, meta: { title: "organizations" } },
    { path: "/organizations/:slug", component: OrganizationView, meta: { title: "organizations" } },
    { path: "/settings/account", component: AccountSettingsView, meta: { title: "account" } },
    { path: "/settings/agents", component: AgentSettingsView, meta: { title: "agents" } },
    { path: "/settings/agents/:id", component: AgentWebhookSettings, meta: { title: "agents" } },
    {
      path: "/settings/agents/:id/webhook",
      component: AgentWebhookSettings,
      meta: { title: "agents" },
    },
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
      path: "/:owner/:repo/commit/:oid([0-9a-f]{40})",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    {
      path: "/:owner/:repo/:view(tree|blob|history|blame)/:path(.*)*",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    {
      path: "/:owner/:repo/:section(code|issues|pulls|discussions|wiki|tasks|commits|compare|releases|forks|settings|agents|deploy|actions)?",
      component: RepositoryView,
      meta: { allowAnonymous: true },
    },
    {
      path: "/:pathMatch(.*)*",
      component: NotFoundView,
      meta: { allowAnonymous: true, title: "notFoundTitle" },
    },
  ],
});

router.beforeEach(async (to, from) => {
  if (!sessionState.checked) await refreshSession();
  if (!to.meta.public && !to.meta.allowAnonymous && !sessionState.user) {
    if (sessionState.view === "guest" && from.matched.length) return false;
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  if (to.meta.landing && sessionState.user && sessionState.view !== "guest") return "/dashboard";
  if ((to.path === "/login" || to.path === "/register") && sessionState.user) {
    if (to.path === "/login" && to.query.add === "1") return;
    return "/dashboard";
  }
});
