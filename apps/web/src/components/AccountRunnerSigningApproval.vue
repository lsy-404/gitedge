<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { RunnerOverviewRunner } from "../../../../packages/contracts/src/runners";
import type { Repository } from "../lib/api";
import { errorMessage } from "../lib/api";
import { approveRunnerSigning, revokeRunnerSigning } from "../lib/runnerSigning";
import { useReauthRetry } from "../lib/reauth";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import StatusBadge from "./StatusBadge.vue";
import AccountRunnerSigningProfiles from "./AccountRunnerSigningProfiles.vue";

const props = defineProps<{
  runner: RunnerOverviewRunner;
  accountRunner: Pick<Repository, "id" | "owner" | "slug"> | null;
}>();
const emit = defineEmits<{ updated: [] }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const platform = ref<"windows" | "macos" | "ios">("windows");
const dedicatedConfirmed = ref(false);
const busy = ref<"approve" | "revoke" | null>(null);
const error = ref("");
const applicable = computed(
  () =>
    props.accountRunner !== null &&
    props.runner.scope.owner === props.accountRunner.owner &&
    props.runner.scope.repository === props.accountRunner.slug
);
const approved = computed(() => props.runner.executionClass === "signing");

async function approve(): Promise<void> {
  if (busy.value || !applicable.value || !dedicatedConfirmed.value) return;
  busy.value = "approve";
  error.value = "";
  try {
    await approveRunnerSigning(props.runner.id, {
      platform: platform.value,
      dedicatedHostConfirmed: true,
    });
    dedicatedConfirmed.value = false;
    emit("updated");
  } catch (cause) {
    if (reauth.intercept(cause, approve)) return;
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = null;
  }
}

async function revoke(): Promise<void> {
  if (busy.value || !approved.value || !applicable.value) return;
  if (!window.confirm(t("runnerSigningRevokeConfirm"))) return;
  busy.value = "revoke";
  error.value = "";
  try {
    await revokeRunnerSigning(props.runner.id);
    emit("updated");
  } catch (cause) {
    if (reauth.intercept(cause, revoke)) return;
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = null;
  }
}

function platformName(value: string | null): string {
  return value ? t(`runnerSigningPlatform_${value}`) : "—";
}

function approvedDate(value: number | null): string {
  return value ? d(new Date(value), "long") : "—";
}
</script>

<template>
  <section v-if="applicable" class="runner-signing-approval" :aria-label="t('runnerSigningTitle')">
    <header>
      <h4>{{ t("runnerSigningTitle") }}</h4>
      <StatusBadge :tone="approved ? 'warning' : 'neutral'">
        {{ t(approved ? "runnerSigningClassDedicated" : "runnerSigningClassGeneral") }}
      </StatusBadge>
    </header>
    <p class="row-meta">{{ t("runnerSigningDescription") }}</p>
    <div v-if="approved" class="row-meta">
      {{ t("runnerSigningApprovedPlatform", { platform: platformName(runner.signingPlatform) }) }} ·
      {{ t("runnerSigningApprovedAt", { time: approvedDate(runner.operatorApprovedAt) }) }}
    </div>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
    <div class="runner-signing-actions">
      <label class="field-label" :for="`runner-signing-platform-${runner.id}`">
        {{ t("runnerSigningPlatform") }}
      </label>
      <select :id="`runner-signing-platform-${runner.id}`" v-model="platform" :disabled="busy !== null">
        <option value="windows">{{ t("runnerSigningPlatform_windows") }}</option>
        <option value="macos">{{ t("runnerSigningPlatform_macos") }}</option>
        <option value="ios">{{ t("runnerSigningPlatform_ios") }}</option>
      </select>
      <label class="runner-signing-confirm">
        <input v-model="dedicatedConfirmed" type="checkbox" :disabled="busy !== null" />
        <span>{{ t("runnerSigningDedicatedConfirm") }}</span>
      </label>
      <p class="row-meta">{{ t("runnerSigningIsolationNote") }}</p>
      <div class="runner-signing-buttons">
        <FluentButton
          type="button"
          :busy="busy === 'approve'"
          :disabled="busy !== null || !dedicatedConfirmed"
          @click="approve"
        >
          {{ t(approved ? "runnerSigningUpdate" : "runnerSigningApprove") }}
        </FluentButton>
        <FluentButton
          v-if="approved"
          type="button"
          tone="danger"
          :busy="busy === 'revoke'"
          :disabled="busy !== null"
          @click="revoke"
        >
          {{ t("runnerSigningRevoke") }}
        </FluentButton>
      </div>
    </div>
    <AccountRunnerSigningProfiles v-if="approved && accountRunner" :repository-id="accountRunner.id" />
  </section>
</template>

<style scoped>
.runner-signing-approval {
  display: grid;
  gap: 0.65rem;
  border-top: 1px solid var(--color-border, #d1d5db);
  padding-top: 0.75rem;
}
.runner-signing-approval header,
.runner-signing-buttons {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}
.runner-signing-approval h4,
.runner-signing-approval p {
  margin: 0;
}
.runner-signing-actions {
  display: grid;
  gap: 0.5rem;
  max-width: 38rem;
}
.runner-signing-actions select {
  min-height: 2.5rem;
  padding: 0.4rem 0.6rem;
}
.runner-signing-confirm {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.runner-signing-confirm input {
  margin-top: 0.2rem;
}
</style>
