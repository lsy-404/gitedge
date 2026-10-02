<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { SsoIdentity, SsoProviderSummary } from "../lib/api";
import { api, ssoAuthorizationUrl } from "../lib/api";
import NoticeBar from "../components/NoticeBar.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { clearSession, sessionState } from "../lib/session";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const providers = ref<SsoProviderSummary[]>([]);
const identities = ref<SsoIdentity[]>([]);
const loading = ref(false);
const loadingError = ref("");
const actionError = ref("");
const notice = ref("");
const busyProviderId = ref("");
const busyIdentityId = ref("");
const busyLogoutIdentityId = ref("");
const linkedNotice = computed(() => route.query.sso === "linked");
const callbackError = computed(() => {
  const code = String(route.query.error || "");
  if (code === "sso_identity_in_use") return t("ssoIdentityInUse");
  if (code === "sso_expired") return t("ssoExpired");
  return code.startsWith("sso_") ? t("ssoLinkError") : "";
});
const externalIdentity = computed(() => {
  const identity = sessionState.user?.externalIdentity;
  if (!identity) return null;
  return {
    login: identity.login,
    label: identity.provider === "github" ? t("providerGithub") : t("providerOidc"),
    avatarUrl: identity.avatarUrl ? ssoAuthorizationUrl(identity.avatarUrl)?.href : undefined,
    profileUrl: identity.profileUrl ? ssoAuthorizationUrl(identity.profileUrl)?.href : undefined,
  };
});
const availableProviders = computed(() =>
  providers.value.filter(
    (provider) => !identities.value.some((identity) => identity.providerId === provider.id)
  )
);

async function load() {
  loading.value = true;
  loadingError.value = "";
  try {
    const [providerResult, identityResult] = await Promise.allSettled([
      api.ssoProviders(),
      api.ssoIdentities(),
    ]);
    if (providerResult.status === "fulfilled") providers.value = providerResult.value;
    else loadingError.value = t("ssoProvidersError");
    if (identityResult.status === "fulfilled") identities.value = identityResult.value;
    else loadingError.value = t("ssoIdentitiesError");
  } finally {
    loading.value = false;
  }
}

async function link(provider: SsoProviderSummary) {
  busyProviderId.value = provider.id;
  actionError.value = "";
  notice.value = "";
  try {
    const response = await api.linkSsoIdentity(provider.id, "/settings/account");
    const target = ssoAuthorizationUrl(response.url);
    if (!target) throw new Error(t("ssoLinkError"));
    window.location.assign(target.href);
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : t("ssoLinkError");
  } finally {
    busyProviderId.value = "";
  }
}

async function unlink(identity: SsoIdentity) {
  busyIdentityId.value = identity.id;
  actionError.value = "";
  notice.value = "";
  try {
    const response = await api.unlinkSsoIdentity(identity.id);
    if (!response.unlinked) throw new Error(t("ssoUnlinkError"));
    identities.value = identities.value.filter((item) => item.id !== identity.id);
    notice.value = t("ssoUnlinked");
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : t("ssoUnlinkError");
  } finally {
    busyIdentityId.value = "";
  }
}

async function federatedLogout(identity: SsoIdentity) {
  busyLogoutIdentityId.value = identity.id;
  actionError.value = "";
  try {
    const response = await api.logoutSsoIdentity(identity.providerId, identity.id);
    clearSession();
    const target = response.url ? ssoAuthorizationUrl(response.url) : null;
    const invalidReturnedUrl = response.url !== null && !target;
    const providerLogoutUnavailable = response.providerLogoutUnavailable || invalidReturnedUrl;
    if (target && !providerLogoutUnavailable) {
      window.location.assign(target.href);
      return;
    }
    await router.replace(
      providerLogoutUnavailable
        ? { path: "/login", query: { error: "sso_logout_unavailable" } }
        : "/login"
    );
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : t("ssoLogoutError");
  } finally {
    busyLogoutIdentityId.value = "";
  }
}

function metadataHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const target = new URL(url);
    return target.protocol === "https:" ? target.href : null;
  } catch {
    return null;
  }
}

onMounted(load);
</script>

<template>
  <section class="page account-settings">
    <div class="page-head">
      <h1>{{ t("account") }}</h1>
    </div>
    <div class="notices">
      <NoticeBar v-if="linkedNotice" intent="success">{{ t("ssoLinked") }}</NoticeBar>
      <NoticeBar v-if="callbackError" intent="error">{{ callbackError }}</NoticeBar>
      <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
      <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
      <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
    </div>

    <section v-if="externalIdentity" class="box" aria-labelledby="linked-provider-heading">
      <div class="box-header">
        <h2 id="linked-provider-heading">{{ t("linkedProvider") }}</h2>
      </div>
      <div class="box-row identity">
        <fluent-avatar size="48" :name="externalIdentity.login">
          <img v-if="externalIdentity.avatarUrl" :src="externalIdentity.avatarUrl" alt="" />
        </fluent-avatar>
        <div class="grow">
          <div class="row-title">
            @{{ externalIdentity.login }}
            <StatusBadge>{{ externalIdentity.label }}</StatusBadge>
          </div>
          <fluent-link
            v-if="externalIdentity.profileUrl"
            :href="externalIdentity.profileUrl"
            target="_blank"
            rel="noreferrer"
            >{{ t("viewProfile") }}</fluent-link
          >
        </div>
      </div>
    </section>
    <div v-else class="box box-form state">
      <p>{{ t("noExternalIdentity") }}</p>
    </div>

    <section class="box box-form sso-settings" aria-labelledby="sso-identities-heading">
      <div class="sso-section-heading">
        <div>
          <h2 id="sso-identities-heading">{{ t("ssoIdentities") }}</h2>
          <p class="muted">{{ t("ssoIdentitiesHint") }}</p>
          <p class="muted">{{ t("ssoFederatedLogoutHint") }}</p>
        </div>
        <fluent-button type="button" appearance="subtle" :disabled="loading" @click="load">{{
          t("refresh")
        }}</fluent-button>
      </div>
      <p v-if="!loading && !identities.length" class="muted">{{ t("ssoNoIdentities") }}</p>
      <ul v-else class="sso-identity-list">
        <li v-for="identity in identities" :key="identity.id" class="sso-identity">
          <div>
            <strong>{{ identity.displayName }}</strong>
            <StatusBadge>{{ identity.protocol.toUpperCase() }}</StatusBadge>
            <p>
              {{ identity.providerLabel }}<span v-if="identity.email"> · {{ identity.email }}</span>
            </p>
            <StatusBadge v-if="identity.email && identity.emailVerified" tone="success">{{
              t("ssoVerifiedEmail")
            }}</StatusBadge>
          </div>
          <div class="sso-actions">
            <fluent-button
              type="button"
              appearance="subtle"
              :disabled="loading || busyIdentityId === identity.id"
              @click="unlink(identity)"
            >
              {{ busyIdentityId === identity.id ? t("loading") : t("ssoUnlink") }}
            </fluent-button>
            <fluent-button
              type="button"
              :aria-label="`${t('ssoFederatedLogout')} · ${identity.providerLabel}`"
              :disabled="loading || busyLogoutIdentityId === identity.id"
              @click="federatedLogout(identity)"
            >
              {{ busyLogoutIdentityId === identity.id ? t("loading") : t("ssoFederatedLogout") }}
            </fluent-button>
          </div>
        </li>
      </ul>
      <div class="sso-provider-list">
        <h3>{{ t("ssoAddIdentity") }}</h3>
        <p v-if="!availableProviders.length" class="muted">{{ t("ssoNoProviders") }}</p>
        <article v-for="provider in availableProviders" :key="provider.id" class="sso-provider">
          <div>
            <strong>{{ provider.label }}</strong>
            <StatusBadge>{{ provider.protocol.toUpperCase() }}</StatusBadge>
            <fluent-link
              v-if="provider.protocol === 'saml' && metadataHref(provider.metadataUrl)"
              :href="metadataHref(provider.metadataUrl) || undefined"
              target="_blank"
              rel="noreferrer"
              >{{ t("ssoMetadata") }}</fluent-link
            >
          </div>
          <fluent-button
            type="button"
            :disabled="loading || busyProviderId === provider.id"
            @click="link(provider)"
          >
            {{ busyProviderId === provider.id ? t("loading") : t("ssoLink") }}
          </fluent-button>
        </article>
      </div>
    </section>
  </section>
</template>
