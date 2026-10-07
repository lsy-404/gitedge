<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField, FluentTextArea } from "@platform-kit/fluent/vue";
import type {
  SigningKey,
  SigningKeyChallenge,
} from "../../../../packages/contracts/src/signatures";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";
const { t, d } = useI18n();
const keys = ref<SigningKey[]>([]),
  challenge = ref<SigningKeyChallenge | null>(null),
  loading = ref(true),
  busy = ref(false),
  showForm = ref(false),
  error = ref("");
const title = ref(""),
  publicKey = ref(""),
  signature = ref("");
async function load() {
  loading.value = true;
  try {
    keys.value = await api.signingKeys();
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}
async function start() {
  busy.value = true;
  error.value = "";
  try {
    if (publicKey.value.includes("PRIVATE KEY")) throw new Error(t("settingsPublicKeyOnly"));
    challenge.value = await api.createSigningChallenge({
      title: title.value,
      publicKey: publicKey.value,
    });
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
async function finish() {
  if (!challenge.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.addSigningKey({ challengeId: challenge.value.id, signature: signature.value });
    challenge.value = null;
    signature.value = "";
    publicKey.value = "";
    title.value = "";
    showForm.value = false;
    await load();
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
async function revoke(key: SigningKey) {
  busy.value = true;
  error.value = "";
  try {
    await api.revokeSigningKey(key.id);
    await load();
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
function download() {
  if (!challenge.value) return;
  const url = URL.createObjectURL(
    new Blob([challenge.value.payload], { type: "text/plain;charset=utf-8" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "gitedge-key-proof.txt";
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(load);
</script>
<template>
  <section class="preference-panel">
    <h2 class="settings-page-title">{{ t("settingsSigning") }}</h2>
    <p class="muted">{{ t("settingsSigningDescription") }}</p>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar
    ><StatusState v-if="loading" :loading="true" />
    <div v-else class="credential-list">
      <div v-if="!keys.length" class="settings-surface muted">{{ t("settingsNoKeys") }}</div>
      <article v-for="key in keys" :key="key.id" class="settings-surface credential-row">
        <div>
          <h3>{{ key.title }}</h3>
          <p>
            <code>{{ key.fingerprint }}</code>
          </p>
          <p class="muted">
            {{ t(key.revokedAt ? "settingsRevoked" : "settingsRegistered") }} ·
            {{ d(key.createdAt, "short") }}
          </p>
        </div>
        <FluentButton v-if="!key.revokedAt" tone="danger" :disabled="busy" @click="revoke(key)">{{
          t("settingsRevoke")
        }}</FluentButton>
      </article>
    </div>
    <FluentButton v-if="!showForm" tone="primary" @click="showForm = true">{{
      t("settingsNewKey")
    }}</FluentButton>
    <form v-else-if="!challenge" class="settings-surface form-stack" @submit.prevent="start">
      <FluentField v-model="title" :label="t('settingsKeyTitle')" maxlength="80" required />
      <FluentTextArea
        v-model="publicKey"
        :label="t('settingsPublicKey')"
        rows="8"
        maxlength="32768"
        required
        spellcheck="false"
        placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
      />
      <div class="settings-actions">
        <FluentButton type="submit" tone="primary" :busy="busy">{{
          t("settingsCreateChallenge")
        }}</FluentButton
        ><FluentButton :disabled="busy" @click="showForm = false">{{ t("cancel") }}</FluentButton>
      </div>
    </form>
    <form v-else class="settings-surface form-stack" @submit.prevent="finish">
      <h3>{{ t("settingsProofTitle") }}</h3>
      <p>{{ t("settingsProofDescription") }}</p>
      <FluentButton @click="download">{{ t("settingsDownloadChallenge") }}</FluentButton>
      <pre class="settings-code">
gpg --armor --detach-sign --local-user {{ challenge.fingerprint }} gitedge-key-proof.txt</pre>
      <FluentTextArea
        v-model="signature"
        :label="t('settingsDetachedSignature')"
        rows="6"
        maxlength="16384"
        required
        spellcheck="false"
        placeholder="-----BEGIN PGP SIGNATURE-----"
      />
      <div class="settings-actions">
        <FluentButton type="submit" tone="primary" :busy="busy">{{
          t("settingsFinishKey")
        }}</FluentButton
        ><FluentButton :disabled="busy" @click="challenge = null">{{ t("back") }}</FluentButton>
      </div>
    </form>
  </section>
</template>
