<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { SsoIdentity, SsoProviderSummary } from "../lib/api";
import { api, ssoAuthorizationUrl } from "../lib/api";
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
    <p class="eyebrow">{{ t("settings") }} / {{ t("account") }}</p>
    <h1>{{ t("account") }}</h1>
    <p v-if="linkedNotice" class="state success" role="status">{{ t("ssoLinked") }}</p>
    <p v-if="callbackError" class="state error" role="alert">{{ callbackError }}</p>
    <p v-if="loadingError" class="state error" role="alert">{{ loadingError }}</p>
    <p v-if="actionError" class="state error" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="state success" role="status">{{ notice }}</p>

    <div v-if="sessionState.user?.externalIdentity" class="panel identity-panel">
      <div class="identity-heading">
        <img
          v-if="sessionState.user.externalIdentity.avatarUrl"
          :src="sessionState.user.externalIdentity.avatarUrl"
          alt=""
        />
        <div>
          <h2>GitHub</h2>
          <a
            v-if="sessionState.user.externalIdentity.profileUrl"
            :href="sessionState.user.externalIdentity.profileUrl"
            target="_blank"
            rel="noreferrer"
            >@{{ sessionState.user.externalIdentity.login }}</a
          ><span v-else>@{{ sessionState.user.externalIdentity.login }}</span>
        </div>
      </div>
      <dl class="identity-details">
        <dt>{{ t("accessLevel") }}</dt>
        <dd>
          {{
            sessionState.user.externalIdentity.accessLevel === "read"
              ? t("readAccess")
              : t("identityAccess")
          }}
        </dd>
        <dt>{{ t("emails") }}</dt>
        <dd>
          <span v-if="sessionState.user.externalIdentity.emails?.length">{{
            sessionState.user.externalIdentity.emails.join(", ")
          }}</span
          ><span v-else class="muted">{{ t("noConnectedData") }}</span>
        </dd>
        <dt>{{ t("organizations") }}</dt>
        <dd>
          <span
            v-if="sessionState.user.externalIdentity.organizations?.length"
            class="identity-list"
            >{{
              sessionState.user.externalIdentity.organizations.map((item) => item.login).join(", ")
            }}</span
          ><span v-else class="muted">{{ t("noConnectedData") }}</span>
        </dd>
      </dl>
    </div>
    <div v-else class="panel state github-identity-empty">
      <p>{{ t("noGithubIdentity") }}</p>
    </div>

    <section class="panel sso-settings" :aria-labelledby="`sso-identities-heading`">
      <div class="sso-section-heading">
        <div>
          <h2 id="sso-identities-heading">{{ t("ssoIdentities") }}</h2>
          <p class="muted">{{ t("ssoIdentitiesHint") }}</p>
          <p class="muted">{{ t("ssoFederatedLogoutHint") }}</p>
        </div>
        <button class="button ghost" :disabled="loading" @click="load">{{ t("refresh") }}</button>
      </div>
      <p v-if="!loading && !identities.length" class="muted">{{ t("ssoNoIdentities") }}</p>
      <ul v-else class="sso-identity-list">
        <li v-for="identity in identities" :key="identity.id" class="sso-identity">
          <div>
            <strong>{{ identity.displayName }}</strong>
            <span class="protocol-badge">{{ identity.protocol.toUpperCase() }}</span>
            <p>
              {{ identity.providerLabel }}<span v-if="identity.email"> · {{ identity.email }}</span>
            </p>
            <small v-if="identity.email && identity.emailVerified" class="verified-email">{{
              t("ssoVerifiedEmail")
            }}</small>
          </div>
          <button
            class="button ghost"
            :disabled="loading || busyIdentityId === identity.id"
            @click="unlink(identity)"
          >
            {{ busyIdentityId === identity.id ? t("loading") : t("ssoUnlink") }}
          </button>
          <button
            class="button"
            :aria-label="`${t('ssoFederatedLogout')} · ${identity.providerLabel}`"
            :disabled="loading || busyLogoutIdentityId === identity.id"
            @click="federatedLogout(identity)"
          >
            {{ busyLogoutIdentityId === identity.id ? t("loading") : t("ssoFederatedLogout") }}
          </button>
        </li>
      </ul>
      <div class="sso-provider-list">
        <h3>{{ t("ssoAddIdentity") }}</h3>
        <p v-if="!availableProviders.length" class="muted">{{ t("ssoNoProviders") }}</p>
        <article v-for="provider in availableProviders" :key="provider.id" class="sso-provider">
          <div>
            <strong>{{ provider.label }}</strong>
            <span class="protocol-badge">{{ provider.protocol.toUpperCase() }}</span>
            <a
              v-if="provider.protocol === 'saml' && metadataHref(provider.metadataUrl)"
              class="metadata-link"
              :href="metadataHref(provider.metadataUrl) || undefined"
              target="_blank"
              rel="noreferrer"
              >{{ t("ssoMetadata") }}</a
            >
          </div>
          <button
            class="button"
            :disabled="loading || busyProviderId === provider.id"
            @click="link(provider)"
          >
            {{ busyProviderId === provider.id ? t("loading") : t("ssoLink") }}
          </button>
        </article>
      </div>
    </section>
  </section>
</template>
