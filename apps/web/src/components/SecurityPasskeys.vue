<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { PasskeySummary, SecuritySummary } from "../../../../packages/contracts/src/security";
import { api } from "../lib/api";
import { securityErrorMessage } from "../lib/security";
import {
  browserSupportsWebAuthn,
  passkeyPromptCancelled,
  promptPasskeyRegistration,
} from "../lib/webauthn";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import TextField from "./TextField.vue";

defineProps<{ summary: SecuritySummary; locked: boolean }>();
const emit = defineEmits<{ changed: []; codes: [codes: string[]] }>();
const { t, d } = useI18n();
const supported = browserSupportsWebAuthn();
const name = ref("");
const renamingId = ref("");
const renameValue = ref("");
const busy = ref(false);
const error = ref("");

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = passkeyPromptCancelled(cause)
      ? t("passkeyCancelled")
      : securityErrorMessage(cause, t, { 409: "passkeyLimit" });
  } finally {
    busy.value = false;
    emit("changed");
  }
}

const add = () =>
  run(async () => {
    const { options } = await api.passkeyRegistrationOptions();
    const response = await promptPasskeyRegistration(options);
    const result = await api.addPasskey(name.value.trim(), response);
    name.value = "";
    if (result.recoveryCodes) emit("codes", result.recoveryCodes);
  });

const rename = (passkey: PasskeySummary) =>
  run(async () => {
    await api.renamePasskey(passkey.id, renameValue.value.trim());
    renamingId.value = "";
  });

const remove = (passkey: PasskeySummary) =>
  run(async () => void (await api.removePasskey(passkey.id)));

function startRename(passkey: PasskeySummary): void {
  renamingId.value = passkey.id;
  renameValue.value = passkey.name;
}
</script>

<template>
  <section class="box" aria-labelledby="security-passkeys-title">
    <header class="box-header">
      <h3 id="security-passkeys-title">{{ t("passkeysTitle") }}</h3>
      <StatusBadge>{{ summary.passkeys.length }}</StatusBadge>
    </header>
    <p class="box-form muted">{{ t("passkeysHint") }}</p>
    <p v-if="!summary.passkeys.length" class="settings-empty">{{ t("passkeysEmpty") }}</p>
    <ul v-else class="settings-list" :aria-label="t('passkeysTitle')">
      <li v-for="passkey in summary.passkeys" :key="passkey.id" class="box-row settings-item">
        <form
          v-if="renamingId === passkey.id"
          class="settings-item-copy"
          @submit.prevent="rename(passkey)"
        >
          <TextField v-model="renameValue" required maxlength="80">{{
            t("passkeyName")
          }}</TextField>
          <div class="settings-actions">
            <FluentButton type="submit" tone="primary" :disabled="busy">{{
              t("save")
            }}</FluentButton>
            <FluentButton type="button" @click="renamingId = ''">{{ t("cancel") }}</FluentButton>
          </div>
        </form>
        <template v-else>
          <div class="settings-item-copy">
            <div class="row-title">
              {{ passkey.name }}
              <StatusBadge v-if="passkey.backedUp">{{ t("passkeySynced") }}</StatusBadge>
            </div>
            <div class="row-meta">
              <span>{{ t("settingsSessionCreated") }} · {{ d(passkey.createdAt, "short") }}</span>
              <span v-if="passkey.lastUsedAt"
                >{{ t("passkeyLastUsed") }} · {{ d(passkey.lastUsedAt, "short") }}</span
              >
            </div>
          </div>
          <div class="settings-actions">
            <FluentButton
              type="button"
              tone="subtle"
              :disabled="busy"
              @click="startRename(passkey)"
              >{{ t("passkeyRename") }}</FluentButton
            >
            <ConfirmButton
              :label="t('settingsRevoke')"
              :prompt="t('confirmRemovePasskey')"
              :disabled="locked || busy"
              @confirm="remove(passkey)"
            />
          </div>
        </template>
      </li>
    </ul>
    <form v-if="supported" class="box-form form-stack" @submit.prevent="add">
      <TextField v-model="name" required maxlength="80" :disabled="locked">{{
        t("passkeyName")
      }}</TextField>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="submit" tone="primary" :disabled="locked || busy">{{
          busy ? t("loading") : t("passkeyAdd")
        }}</FluentButton>
      </div>
    </form>
    <p v-else class="box-form muted">{{ t("passkeysUnsupported") }}</p>
  </section>
</template>
