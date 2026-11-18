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
import { errorMessage } from "../lib/api";
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
import TextField from "./TextField.vue";

const props = defineProps<{ repositoryId: string }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const profileName = ref("");
const profiles = ref<SigningProfileMetadata[]>([]);
const statuses = ref(new Map<string, SigningCredentialStatus>());
const loading = ref(false);
const sourceBatch = Symbol("source batch");
const busy = ref<string | typeof sourceBatch | null>(null);
const error = ref("");
const sourceToken = ref("");
const sourceProfiles = ref<string[]>([]);
const sourceSaved = ref(0);
const sourceFailed = ref<string[]>([]);
const windowsFormProfile = ref<string | null>(null);
const windowsTenantId = ref("");
const windowsClientId = ref("");
const windowsClientSecret = ref("");
let windowsFormGeneration = 0;

function clearWindowsForm(): void {
  windowsFormGeneration += 1;
  windowsTenantId.value = "";
  windowsClientId.value = "";
  windowsClientSecret.value = "";
  windowsFormProfile.value = null;
}

function toggleWindowsForm(profile: SigningProfileMetadata): void {
  if (windowsFormProfile.value === profile.name) {
    clearWindowsForm();
    return;
  }
  clearWindowsForm();
  windowsFormProfile.value = profile.name;
}

async function installWindows(profile: SigningProfileMetadata): Promise<void> {
  if (busy.value || windowsFormProfile.value !== profile.name) return;
  try {
    windowsCredentialsSchema.parse({
      tenant_id: windowsTenantId.value,
      client_id: windowsClientId.value,
      client_secret: windowsClientSecret.value,
    });
  } catch {
    error.value = t("runnerSigningWindowsCredentialsInvalid");
    return;
  }
  const generation = windowsFormGeneration;
  const operation = async () => {
    if (generation !== windowsFormGeneration || windowsFormProfile.value !== profile.name) return;
    let currentCredentials: unknown;
    try {
      currentCredentials = windowsCredentialsSchema.parse({
        tenant_id: windowsTenantId.value,
        client_id: windowsClientId.value,
        client_secret: windowsClientSecret.value,
      });
    } catch {
      error.value = t("runnerSigningWindowsCredentialsInvalid");
      return;
    }
    busy.value = profile.name;
    error.value = "";
    try {
      const status = await installSigningCredentials(
        props.repositoryId,
        profile.name,
        "windows",
        currentCredentials
      );
      statuses.value = new Map(statuses.value).set(statusKey(profile.name, "windows"), status);
      clearWindowsForm();
    } catch (cause) {
      if (reauth.intercept(cause, operation)) return;
      error.value = errorMessage(cause, t);
    } finally {
      busy.value = null;
    }
  };
  await operation();
}

function finishSourceBatch(): void {
  sourceToken.value = "";
  busy.value = null;
}

function cancelSourceBatch(): void {
  reauth.pending.value = null;
  finishSourceBatch();
}

async function installSourceBatch(): Promise<void> {
  if (busy.value || reauth.pending.value || !sourceProfiles.value.length) return;
  if (!SigningSourceCredentialSchema.safeParse({ token: sourceToken.value.trim() }).success) return;

  const selected = [...sourceProfiles.value];
  const repositoryId = props.repositoryId;
  let next = 0;
  sourceSaved.value = 0;
  sourceFailed.value = [];
  error.value = "";
  busy.value = sourceBatch;

  const operation = async () => {
    for (; next < selected.length; next += 1) {
      const name = selected[next]!;
      try {
        const status = await installSigningCredentials(repositoryId, name, "github-source", {
          token: sourceToken.value.trim(),
        });
        statuses.value.set(statusKey(name, "github-source"), status);
        sourceSaved.value += 1;
        sourceProfiles.value = sourceProfiles.value.filter((selectedName) => selectedName !== name);
      } catch (cause) {
        if (reauth.intercept(cause, operation)) return;
        sourceFailed.value.push(name);
      }
    }
    finishSourceBatch();
  };
  await operation();
}

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
    <form
      v-if="profiles.length"
      class="source-credentials-form"
      @submit.prevent="installSourceBatch"
    >
      <TextField
        v-model="sourceToken"
        type="password"
        autocomplete="new-password"
        spellcheck="false"
        maxlength="512"
        required
        :disabled="busy !== null || !!reauth.pending.value"
        >{{ t("runnerSigningSourceToken") }}</TextField
      >
      <fieldset class="source-profile-choices" :disabled="busy !== null || !!reauth.pending.value">
        <legend class="field-label">{{ t("runnerSigningSourceProfiles") }}</legend>
        <label v-for="profile in profiles" :key="profile.name" class="inline-choice">
          <input v-model="sourceProfiles" type="checkbox" :value="profile.name" />
          {{ profile.name }}
        </label>
      </fieldset>
      <div class="profile-actions">
        <FluentButton
          type="submit"
          tone="primary"
          :busy="busy === sourceBatch && !reauth.pending.value"
          :disabled="
            busy !== null || !!reauth.pending.value || !sourceToken.trim() || !sourceProfiles.length
          "
          >{{ t("runnerSigningSourceSave", { count: sourceProfiles.length }) }}</FluentButton
        >
        <FluentButton
          v-if="busy === sourceBatch && reauth.pending.value"
          type="button"
          @click="cancelSourceBatch"
          >{{ t("runnerSigningSourceCancel") }}</FluentButton
        >
      </div>
      <NoticeBar v-if="sourceSaved" intent="success">
        {{ t("runnerSigningSourceSaved", { count: sourceSaved }) }}
      </NoticeBar>
      <NoticeBar v-if="sourceFailed.length" intent="error">
        {{ t("runnerSigningSourceFailed", { profiles: sourceFailed.join(", ") }) }}
      </NoticeBar>
    </form>
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
      <div v-if="profile.platform === 'windows'" class="profile-actions">
        <FluentButton type="button" :disabled="busy !== null" @click="toggleWindowsForm(profile)">{{
          windowsFormProfile === profile.name
            ? t("runnerSigningWindowsCredentialsCancel")
            : t("runnerSigningWindowsCredentialsInstall")
        }}</FluentButton>
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
      <form
        v-if="profile.platform === 'windows' && windowsFormProfile === profile.name"
        class="windows-credentials-form"
        @submit.prevent="installWindows(profile)"
      >
        <label :for="`runner-signing-windows-tenant-${profile.name}`">tenant_id</label>
        <input
          :id="`runner-signing-windows-tenant-${profile.name}`"
          v-model.trim="windowsTenantId"
          autocomplete="off"
          spellcheck="false"
          required
          :disabled="busy !== null"
        />
        <label :for="`runner-signing-windows-client-${profile.name}`">client_id</label>
        <input
          :id="`runner-signing-windows-client-${profile.name}`"
          v-model.trim="windowsClientId"
          autocomplete="off"
          spellcheck="false"
          required
          :disabled="busy !== null"
        />
        <label :for="`runner-signing-windows-secret-${profile.name}`">client_secret</label>
        <input
          :id="`runner-signing-windows-secret-${profile.name}`"
          v-model="windowsClientSecret"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          required
          :disabled="busy !== null"
        />
        <div class="profile-actions">
          <FluentButton
            type="submit"
            tone="primary"
            :busy="busy === profile.name"
            :disabled="busy !== null"
            >{{ t("runnerSigningWindowsCredentialsSave") }}</FluentButton
          >
          <FluentButton type="button" :disabled="busy !== null" @click="clearWindowsForm">
            {{ t("runnerSigningWindowsCredentialsCancel") }}
          </FluentButton>
        </div>
      </form>
      <div v-else-if="profile.platform !== 'windows'" class="profile-actions">
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
.signing-profile,
.source-credentials-form,
.windows-credentials-form {
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
.source-credentials-form {
  max-width: 38rem;
}
.source-profile-choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-2);
  margin: 0;
  min-width: 0;
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
.windows-credentials-form {
  grid-template-columns: minmax(8rem, auto) minmax(12rem, 1fr);
  align-items: center;
  max-width: 38rem;
}
.windows-credentials-form input {
  min-height: 2.5rem;
  padding: 0.4rem 0.6rem;
}
.windows-credentials-form .profile-actions {
  grid-column: 1 / -1;
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
