<script setup lang="ts">
import { windowsCredentialsSchema } from "../../../../packages/contracts/signing-native.mjs";
import { SigningSourceCredentialSchema } from "../../../../packages/contracts/src/signing";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  SigningCredentialStatus,
  SigningCredentialPlatform,
  SigningProfileMetadata,
} from "../../../../packages/contracts/src/signing";
import { api, errorMessage } from "../lib/api";
import {
  approveSigningProfile,
  getSigningCredentialStatus,
  installSigningCredentials,
  listSigningProfiles,
  removeSigningCredentials,
} from "../lib/runnerSigning";
import { useReauthRetry } from "../lib/reauth";
import { FluentButton } from "@platform-kit/fluent/vue";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";

const props = defineProps<{ repositoryId: string }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const profileName = ref("");
const profiles = ref<SigningProfileMetadata[]>([]);
const statuses = ref(new Map<string, SigningCredentialStatus>());
const loading = ref(false);
const busy = ref<string | null>(null);
const error = ref("");

function isCredentialObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    profiles.value = await listSigningProfiles(props.repositoryId);
    const next = new Map<string, SigningCredentialStatus>();
    await Promise.all(
      profiles.value.flatMap((profile) =>
        ([profile.platform, "github-source"] as SigningCredentialPlatform[]).map(
          async (platform) => {
            try {
              next.set(
                statusKey(profile.name, platform),
                await getSigningCredentialStatus(props.repositoryId, profile.name, platform)
              );
            } catch {
              // Missing credentials remain visible as not configured.
            }
          }
        )
      )
    );
    statuses.value = next;
  } catch (cause) {
    if (reauth.intercept(cause, refresh)) return;
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

async function approve(): Promise<void> {
  if (busy.value || !/^[a-z][a-z0-9-]{0,63}$/.test(profileName.value)) return;
  const name = profileName.value;
  busy.value = "approve";
  error.value = "";
  try {
    await approveSigningProfile(props.repositoryId, name);
    profileName.value = "";
    await refresh();
  } catch (cause) {
    if (reauth.intercept(cause, approve)) return;
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = null;
  }
}

async function install(
  profile: SigningProfileMetadata,
  platform: SigningCredentialPlatform,
  event: Event
): Promise<void> {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = "";
  if (!file || file.size > 64 * 1024) {
    error.value = t("runnerSigningCredentialsFileInvalid");
    return;
  }
  let credentials: unknown;
  try {
    credentials = JSON.parse(await file.text());
    if (!isCredentialObject(credentials)) throw new Error("invalid_credentials");
    const values = credentials;
    if (platform === "github-source") credentials = SigningSourceCredentialSchema.parse(values);
    else if (platform === "windows") credentials = windowsCredentialsSchema.parse(values);
  } catch {
    error.value = t("runnerSigningCredentialsFileInvalid");
    return;
  }
  const operation = async () => {
    busy.value = profile.name;
    error.value = "";
    try {
      const status = await installSigningCredentials(
        props.repositoryId,
        profile.name,
        platform,
        credentials
      );
      statuses.value = new Map(statuses.value).set(statusKey(profile.name, platform), status);
    } catch (cause) {
      if (reauth.intercept(cause, operation)) return;
      error.value = errorMessage(cause, t);
    } finally {
      busy.value = null;
    }
  };
  await operation();
}

async function remove(
  profile: SigningProfileMetadata,
  platform: SigningCredentialPlatform
): Promise<void> {
  if (busy.value || !window.confirm(t("runnerSigningCredentialsRemoveConfirm"))) return;
  const operation = async () => {
    busy.value = profile.name;
    error.value = "";
    try {
      const status = await removeSigningCredentials(props.repositoryId, profile.name, platform);
      statuses.value = new Map(statuses.value).set(statusKey(profile.name, platform), status);
    } catch (cause) {
      if (reauth.intercept(cause, operation)) return;
      error.value = errorMessage(cause, t);
    } finally {
      busy.value = null;
    }
  };
  await operation();
}

async function importCredentials(profile: SigningProfileMetadata): Promise<void> {
  if (busy.value) return;
  const operation = async () => {
    busy.value = profile.name;
    error.value = "";
    try {
      const platforms: ("macos" | "ios" | "github-source")[] = ["github-source"];
      if (profile.platform === "macos" || profile.platform === "ios")
        platforms.push(profile.platform);
      for (const platform of platforms) {
        const status = await api.importSigningCredentials(
          props.repositoryId,
          profile.name,
          platform
        );
        statuses.value = new Map(statuses.value).set(statusKey(profile.name, platform), status);
      }
    } catch (cause) {
      if (reauth.intercept(cause, operation)) return;
      error.value = errorMessage(cause, t);
    } finally {
      busy.value = null;
    }
  };
  await operation();
}

function statusKey(name: string, platform: SigningCredentialPlatform): string {
  return `${name}:${platform}`;
}

function statusFor(
  profile: SigningProfileMetadata,
  platform: SigningCredentialPlatform
): SigningCredentialStatus | undefined {
  return statuses.value.get(statusKey(profile.name, platform));
}

onMounted(() => void refresh());
</script>

<template>
  <section class="signing-profiles" :aria-label="t('runnerSigningProfilesTitle')">
    <h4>{{ t("runnerSigningProfilesTitle") }}</h4>
    <p class="row-meta">{{ t("runnerSigningProfilesDescription") }}</p>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
    <form class="profile-approval" @submit.prevent="approve">
      <label class="field-label" for="runner-signing-profile-name">{{
        t("runnerSigningProfileName")
      }}</label>
      <input
        id="runner-signing-profile-name"
        v-model.trim="profileName"
        autocomplete="off"
        maxlength="64"
        pattern="[a-z][a-z0-9-]{0,63}"
        :placeholder="t('runnerSigningProfileNameExample')"
      />
      <FluentButton
        type="submit"
        :busy="busy === 'approve'"
        :disabled="busy !== null || !profileName"
      >
        {{ t("runnerSigningProfileApprove") }}
      </FluentButton>
    </form>
    <p class="row-meta">{{ t("runnerSigningProfilePathHint") }}</p>
    <p v-if="loading && !profiles.length" class="row-meta">{{ t("loading") }}</p>
    <article v-for="profile in profiles" :key="profile.name" class="signing-profile">
      <div>
        <strong>{{ profile.name }}</strong>
        <span class="row-meta"> · {{ t(`runnerSigningPlatform_${profile.platform}`) }}</span>
      </div>
      <div class="row-meta">
        {{ profile.workflowPath }} · {{ profile.workflowOid.slice(0, 12) }}
      </div>
      <div class="row-meta">
        {{
          t("runnerSigningPlatformCredential", {
            status: statusFor(profile, profile.platform)?.configured
              ? t("runnerSigningCredentialConfigured")
              : t("runnerSigningCredentialMissing"),
          })
        }}
        <span v-if="statusFor(profile, profile.platform)?.updatedAt">
          · {{ d(new Date(statusFor(profile, profile.platform)!.updatedAt!), "long") }}</span
        >
      </div>
      <p v-if="profile.platform === 'windows'" class="row-meta">
        {{ t("runnerSigningWindowsCredentialsHelp") }}
      </p>
      <div class="profile-actions">
        <FluentButton type="button" :disabled="busy !== null" @click="importCredentials(profile)">
          从旧签名服务加密迁入
        </FluentButton>
        <label class="file-button">
          {{ t("runnerSigningCredentialsInstall") }}
          <input
            type="file"
            accept="application/json,.json"
            :disabled="busy !== null"
            @change="install(profile, profile.platform, $event)"
          />
        </label>
        <FluentButton
          v-if="statusFor(profile, profile.platform)?.configured"
          type="button"
          tone="danger"
          :busy="busy === profile.name"
          :disabled="busy !== null"
          @click="remove(profile, profile.platform)"
          >{{ t("runnerSigningCredentialsRemove") }}</FluentButton
        >
      </div>
      <div class="row-meta">
        {{
          t("runnerSigningSourceCredential", {
            status: statusFor(profile, "github-source")?.configured
              ? t("runnerSigningCredentialConfigured")
              : t("runnerSigningCredentialMissing"),
          })
        }}
        <span v-if="statusFor(profile, 'github-source')?.updatedAt">
          · {{ d(new Date(statusFor(profile, "github-source")!.updatedAt!), "long") }}</span
        >
      </div>
      <div class="profile-actions">
        <label class="file-button">
          {{ t("runnerSigningSourceCredentialsInstall") }}
          <input
            type="file"
            accept="application/json,.json"
            :disabled="busy !== null"
            @change="install(profile, 'github-source', $event)"
          />
        </label>
        <FluentButton
          v-if="statusFor(profile, 'github-source')?.configured"
          type="button"
          tone="danger"
          :busy="busy === profile.name"
          :disabled="busy !== null"
          @click="remove(profile, 'github-source')"
          >{{ t("runnerSigningCredentialsRemove") }}</FluentButton
        >
      </div>
    </article>
    <p v-if="!loading && !profiles.length" class="row-meta">
      {{ t("runnerSigningProfilesEmpty") }}
    </p>
  </section>
</template>

<style scoped>
.signing-profiles {
  display: grid;
  gap: 0.65rem;
  border-top: 1px solid var(--color-border, #d1d5db);
  padding-top: 0.75rem;
}
.signing-profiles h4,
.signing-profiles p {
  margin: 0;
}
.profile-approval,
.signing-profile {
  display: grid;
  gap: 0.5rem;
}
.profile-approval {
  grid-template-columns: minmax(12rem, 1fr) auto;
  align-items: end;
  max-width: 38rem;
}
.profile-approval label {
  grid-column: 1 / -1;
}
.profile-approval input {
  min-height: 2.5rem;
  padding: 0.4rem 0.6rem;
}
.signing-profile {
  border-top: 1px solid var(--color-border, #d1d5db);
  padding-top: 0.65rem;
}
.profile-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}
.file-button {
  display: inline-flex;
  align-items: center;
  min-height: 2.25rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.35rem;
  cursor: pointer;
}
.file-button input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
