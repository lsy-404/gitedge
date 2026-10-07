<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { SsoIdentity, SsoProviderSummary } from "../lib/api";
import { api, errorMessage, ssoAuthorizationUrl } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import { clearSession, sessionState } from "../lib/session";
import { FluentButton } from "@platform-kit/fluent/vue";

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
    if (!target) {
      actionError.value = t("ssoLinkError");
      return;
    }
    window.location.assign(target.href);
  } catch (cause) {
    actionError.value = errorMessage(cause, t, {}, "ssoLinkError");
  } finally {
    busyProviderId.value = "";
  }
}

async function unlink(identity: SsoIdentity) {
  if (busyIdentityId.value || busyLogoutIdentityId.value) return;
  busyIdentityId.value = identity.id;
  actionError.value = "";
  notice.value = "";
  try {
    const response = await api.unlinkSsoIdentity(identity.id);
    if (!response.unlinked) {
      actionError.value = t("ssoUnlinkError");
      return;
    }
    identities.value = identities.value.filter((item) => item.id !== identity.id);
    notice.value = t("ssoUnlinked");
  } catch (cause) {
    actionError.value = errorMessage(cause, t, { 409: "ssoUnlinkLastMethod" }, "ssoUnlinkError");
  } finally {
    busyIdentityId.value = "";
  }
}

async function federatedLogout(identity: SsoIdentity) {
  if (busyIdentityId.value || busyLogoutIdentityId.value) return;
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
    actionError.value = errorMessage(cause, t, {}, "ssoLogoutError");
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
  <section class="account-settings">
    <h2 class="settings-page-title">{{ t("accountSettingsTitle") }}</h2>
    <div class="settings-notices">
      <NoticeBar v-if="linkedNotice" intent="success">{{ t("ssoLinked") }}</NoticeBar>
      <NoticeBar v-if="callbackError" intent="error">{{ callbackError }}</NoticeBar>
      <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
      <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
      <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
    </div>

    <section class="settings-section" aria-labelledby="linked-provider-heading">
      <h2 id="linked-provider-heading">{{ t("signInMethods") }}</h2>
      <div v-if="externalIdentity" class="settings-card">
        <div class="settings-card-row identity">
          <span class="avatar" :aria-label="externalIdentity.login">
            <img v-if="externalIdentity.avatarUrl" :src="externalIdentity.avatarUrl" alt="" />
          </span>
          <div class="grow">
            <div class="row-title">
              @{{ externalIdentity.login }}
              <StatusBadge>{{ externalIdentity.label }}</StatusBadge>
            </div>
            <a
              v-if="externalIdentity.profileUrl"
              :href="externalIdentity.profileUrl"
              target="_blank"
              rel="noreferrer"
              >{{ t("viewProfile") }}</a
            >
          </div>
        </div>
      </div>
      <div v-else class="settings-card settings-card-row">
        <div class="settings-card-copy">
          <strong>{{ t("noExternalIdentity") }}</strong>
          <p>{{ t("noExternalIdentityHint") }}</p>
        </div>
      </div>
    </section>

    <section class="settings-section sso-settings" aria-labelledby="sso-identities-heading">
      <div class="settings-section-heading">
        <div>
          <h2 id="sso-identities-heading">{{ t("ssoIdentities") }}</h2>
          <p class="muted">{{ t("ssoIdentitiesHint") }}</p>
          <p class="muted">{{ t("ssoFederatedLogoutHint") }}</p>
        </div>
        <FluentButton
          class="btn btn-sm"
          type="button"
          tone="subtle"
          :disabled="loading"
          @click="load"
          >{{ t("refresh") }}</FluentButton
        >
      </div>
      <div class="settings-card">
        <div v-if="!loading && !identities.length" class="settings-card-row settings-card-copy">
          <strong>{{ t("ssoNoIdentities") }}</strong>
        </div>
        <div v-else class="sso-identity-list">
          <div
            v-for="identity in identities"
            :key="identity.id"
            class="settings-card-row sso-identity"
          >
            <div class="settings-card-copy">
              <strong>{{ identity.displayName }}</strong>
              <StatusBadge>{{ identity.protocol.toUpperCase() }}</StatusBadge>
              <p>
                {{ identity.providerLabel
                }}<span v-if="identity.email"> · {{ identity.email }}</span>
              </p>
              <StatusBadge v-if="identity.email && identity.emailVerified" tone="success">{{
                t("ssoVerifiedEmail")
              }}</StatusBadge>
            </div>
            <div class="sso-actions settings-actions">
              <ConfirmButton
                tone="subtle"
                :label="busyIdentityId === identity.id ? t('loading') : t('ssoUnlink')"
                :accessible-name="`${t('ssoUnlink')} · ${identity.providerLabel}`"
                :prompt="t('confirmUnlinkIdentity')"
                :disabled="loading || busyIdentityId === identity.id"
                @confirm="unlink(identity)"
              />
              <ConfirmButton
                tone="secondary"
                :label="
                  busyLogoutIdentityId === identity.id ? t('loading') : t('ssoFederatedLogout')
                "
                :accessible-name="`${t('ssoFederatedLogout')} · ${identity.providerLabel}`"
                :prompt="t('confirmFederatedLogout')"
                :disabled="loading || busyLogoutIdentityId === identity.id"
                @confirm="federatedLogout(identity)"
              />
            </div>
          </div>
        </div>
      </div>
      <div class="sso-provider-list">
        <h3>{{ t("ssoAddIdentity") }}</h3>
        <p v-if="!availableProviders.length" class="muted">{{ t("ssoNoProviders") }}</p>
        <article
          v-for="provider in availableProviders"
          :key="provider.id"
          class="settings-card-row sso-provider"
        >
          <div class="settings-card-copy">
            <strong>{{ provider.label }}</strong>
            <StatusBadge>{{ provider.protocol.toUpperCase() }}</StatusBadge>
            <a
              v-if="provider.protocol === 'saml' && metadataHref(provider.metadataUrl)"
              :href="metadataHref(provider.metadataUrl) || undefined"
              target="_blank"
              rel="noreferrer"
              >{{ t("ssoMetadata") }}</a
            >
          </div>
          <FluentButton
            type="button"
            :disabled="loading || busyProviderId === provider.id"
            @click="link(provider)"
          >
            {{ busyProviderId === provider.id ? t("loading") : t("ssoLink") }}
          </FluentButton>
        </article>
      </div>
    </section>
  </section>
</template>
