<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  LoginSecondFactorChallenge,
  SecondFactorInput,
  SecondFactorMethod,
} from "../../../../packages/contracts/src/security";
import { api, errorMessage, type User } from "../lib/api";
import { passkeyPromptCancelled, promptPasskeyAuthentication } from "../lib/webauthn";
import NoticeBar from "./NoticeBar.vue";
import TextField from "./TextField.vue";

const props = defineProps<{ challenge: LoginSecondFactorChallenge }>();
const emit = defineEmits<{ done: [user: User]; cancel: [] }>();
const { t } = useI18n();

const order: SecondFactorMethod[] = ["totp", "passkey", "recovery"];
const methods = computed(() => order.filter((item) => props.challenge.methods.includes(item)));
const method = ref<SecondFactorMethod>(methods.value[0] ?? "recovery");
const code = ref("");
const error = ref("");
const busy = ref(false);

const names = {
  totp: "secondFactorTotp",
  passkey: "secondFactorPasskey",
  recovery: "secondFactorRecovery",
} as const;
const hints = {
  totp: "secondFactorTotpHint",
  passkey: "secondFactorPasskeyHint",
  recovery: "secondFactorRecoveryHint",
} as const;

function choose(next: SecondFactorMethod): void {
  method.value = next;
  code.value = "";
  error.value = "";
}

async function complete(factor: SecondFactorInput): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    emit("done", await api.completeLogin(props.challenge.mfaToken, factor));
  } catch (cause) {
    error.value = errorMessage(cause, t, { 401: "secondFactorInvalid", 429: "authRateLimited" });
  } finally {
    busy.value = false;
  }
}

async function submitCode(): Promise<void> {
  if (method.value === "passkey") return;
  await complete({ method: method.value, code: code.value.trim() });
}

async function usePasskey(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const { options } = await api.secondFactorOptions(props.challenge.mfaToken);
    const response = await promptPasskeyAuthentication(options);
    await complete({ method: "passkey", response });
  } catch (cause) {
    error.value = passkeyPromptCancelled(cause)
      ? t("passkeyCancelled")
      : errorMessage(cause, t, { 401: "secondFactorInvalid", 429: "authRateLimited" });
    busy.value = false;
  }
}
</script>

<template>
  <form class="form-stack" aria-labelledby="second-factor-title" @submit.prevent="submitCode">
    <h2 id="second-factor-title" class="auth-step-title">{{ t("secondFactorTitle") }}</h2>
    <p class="muted">{{ t(hints[method]) }}</p>
    <button
      v-if="method === 'passkey'"
      type="button"
      class="btn btn-primary auth-submit"
      :disabled="busy"
      @click="usePasskey"
    >
      {{ busy ? t("loading") : t("passkeyUse") }}
    </button>
    <template v-else>
      <TextField
        :key="method"
        v-model="code"
        required
        autofocus
        autocomplete="one-time-code"
        :inputmode="method === 'totp' ? 'numeric' : 'text'"
        :maxlength="method === 'totp' ? 6 : 32"
        :pattern="method === 'totp' ? '[0-9]{6}' : undefined"
        spellcheck="false"
        >{{ t(names[method]) }}</TextField
      >
      <button type="submit" class="btn btn-primary auth-submit" :disabled="busy">
        {{ busy ? t("loading") : t("secondFactorVerify") }}
      </button>
    </template>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <div
      v-if="methods.length > 1"
      class="auth-alt-methods"
      role="group"
      :aria-label="t('secondFactorOther')"
    >
      <button
        v-for="item in methods.filter((other) => other !== method)"
        :key="item"
        type="button"
        class="btn btn-subtle"
        @click="choose(item)"
      >
        {{ t(names[item]) }}
      </button>
    </div>
    <button type="button" class="btn btn-subtle" @click="emit('cancel')">
      {{ t("secondFactorCancel") }}
    </button>
  </form>
</template>
