<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { Invitation } from "../lib/api";
import { api, ApiError } from "../lib/api";
import { sessionState } from "../lib/session";
import NoticeBar from "../components/NoticeBar.vue";
import StatusBadge from "../components/StatusBadge.vue";
import StatusState from "../components/StatusState.vue";
import "../styles/auth.css";

const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const invitation = ref<Invitation | null>(null);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const token = computed(() => route.hash.replace(/^#/, ""));
const signedIn = computed(() => sessionState.user !== null);
const redirect = computed(() => route.fullPath);

const target = computed(() => {
  const item = invitation.value;
  if (!item) return "";
  return item.repository
    ? `${item.repository.owner}/${item.repository.name}`
    : (item.organization ?? "");
});

function failure(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) return t("inviteNotFound");
  if (cause instanceof ApiError && cause.status === 409)
    return cause.code === "already_member" ? t("inviteAlreadyMember") : t("inviteClosed");
  return t("apiError");
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  if (!signedIn.value || token.value.length < 20) {
    loading.value = false;
    if (signedIn.value) error.value = t("inviteNotFound");
    return;
  }
  try {
    invitation.value = await api.invitationByToken(token.value, "lookup");
  } catch (cause) {
    error.value = failure(cause);
  } finally {
    loading.value = false;
  }
}

async function resolve(action: "accept" | "decline"): Promise<void> {
  if (busy.value || !invitation.value) return;
  busy.value = true;
  error.value = "";
  const joined = invitation.value;
  try {
    await api.invitationByToken(token.value, action);
    if (action === "decline") {
      await router.replace("/dashboard");
      return;
    }
    await router.replace(
      joined.repository
        ? `/${encodeURIComponent(joined.repository.owner)}/${encodeURIComponent(joined.repository.name)}`
        : `/organizations/${encodeURIComponent(joined.organization ?? "")}`
    );
  } catch (cause) {
    error.value = failure(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="auth-page">
    <div class="auth-card">
      <h1>{{ t("inviteAcceptTitle") }}</h1>
      <div class="form-stack">
        <StatusState v-if="loading" :loading="true" />
        <template v-else-if="!signedIn">
          <p>{{ t("inviteSignInFirst") }}</p>
          <div class="form-actions">
            <RouterLink class="btn btn-primary" :to="{ path: '/login', query: { redirect } }">{{
              t("signIn")
            }}</RouterLink>
            <RouterLink class="btn" :to="{ path: '/register', query: { redirect } }">{{
              t("signUp")
            }}</RouterLink>
          </div>
        </template>
        <NoticeBar v-else-if="error" intent="error">{{ error }}</NoticeBar>
        <template v-else-if="invitation">
          <p>
            {{
              t(
                invitation.kind === "organization"
                  ? "invitationToOrganization"
                  : "invitationToRepository",
                { inviter: invitation.inviter, target }
              )
            }}
            <StatusBadge>{{ t(`inviteRole_${invitation.role}`) }}</StatusBadge>
          </p>
          <p class="muted">{{ t("inviteExpires", { date: d(invitation.expiresAt, "long") }) }}</p>
          <div class="form-actions">
            <FluentButton type="button" tone="primary" :busy="busy" @click="resolve('accept')">{{
              t("invitationAccept")
            }}</FluentButton>
            <FluentButton type="button" :disabled="busy" @click="resolve('decline')">{{
              t("invitationDecline")
            }}</FluentButton>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
