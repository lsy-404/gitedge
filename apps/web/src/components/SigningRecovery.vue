<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type {
  SigningProfileMetadata,
  SigningRequest,
} from "../../../../packages/contracts/src/signing";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";

const props = defineProps<{ repositoryId: string; profiles: SigningProfileMetadata[] }>();
const { t } = useI18n();
const requestId = ref("");
const operation = ref("retry");
const profile = ref("");
const artifactId = ref("");
const busy = ref(false);
const error = ref("");
const result = ref<SigningRequest | null>(null);
const enabledProfiles = computed(() => props.profiles.filter((item) => item.enabled));

async function recover(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  result.value = null;
  try {
    if (operation.value === "platform") {
      result.value = await api.recoverSigningPlatform(props.repositoryId, requestId.value, {
        profile: profile.value,
        sourceArtifactId: artifactId.value,
      });
    } else {
      const state = await api.signingRequestStatus(props.repositoryId, requestId.value);
      result.value =
        state.state === "failed"
          ? await api.retrySigningRequest(props.repositoryId, state.id, state.runId)
          : state;
    }
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="signing-recovery">
    <h4>{{ t("signingRecoveryTitle") }}</h4>
    <p>{{ t("signingRecoveryHelp") }}</p>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <NoticeBar v-if="result" intent="info">
      {{ t("signingRecoveryResult", { id: result.id, state: result.state, stage: result.stage }) }}
    </NoticeBar>
    <form @submit.prevent="recover">
      <label for="signing-recovery-operation">{{ t("signingRecoveryOperation") }}</label>
      <select id="signing-recovery-operation" v-model="operation" :disabled="busy">
        <option value="retry">{{ t("signingRecoveryRetry") }}</option>
        <option value="platform">{{ t("signingRecoveryPlatform") }}</option>
      </select>
      <label for="signing-recovery-request">{{ t("signingRecoveryRequest") }}</label>
      <input
        id="signing-recovery-request"
        v-model.trim="requestId"
        required
        pattern="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        autocomplete="off"
        :disabled="busy"
      />
      <template v-if="operation === 'platform'">
        <label for="signing-recovery-profile">{{ t("runnerSigningProfileName") }}</label>
        <select id="signing-recovery-profile" v-model="profile" required :disabled="busy">
          <option v-for="item in enabledProfiles" :key="item.name" :value="item.name">
            {{ item.name }}
          </option>
        </select>
        <label for="signing-recovery-artifact">{{ t("signingRecoveryArtifact") }}</label>
        <input
          id="signing-recovery-artifact"
          v-model.trim="artifactId"
          required
          pattern="[1-9][0-9]*"
          inputmode="numeric"
          :disabled="busy"
        />
      </template>
      <FluentButton type="submit" :busy="busy" :disabled="busy">{{
        t("signingRecoverySubmit")
      }}</FluentButton>
    </form>
  </section>
</template>

<style scoped>
.signing-recovery,
form {
  display: grid;
  gap: 0.5rem;
}
.signing-recovery {
  border-top: 1px solid var(--color-border);
  padding-top: 0.75rem;
}
h4,
p {
  margin: 0;
}
p {
  color: var(--color-text-secondary);
}
form {
  max-width: 38rem;
}
input,
select {
  min-height: 2.5rem;
  padding: 0.4rem 0.6rem;
}
button {
  justify-self: start;
}
</style>
