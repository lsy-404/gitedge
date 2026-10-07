<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField, FluentTextArea } from "@platform-kit/fluent/vue";
import type {
  SigningKey,
  SigningKeyChallenge,
} from "../../../../packages/contracts/src/signatures";
import { api, errorMessage } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
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
  if (busy.value) return;
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
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsSigning") }}</h2>
        <p>{{ t("settingsSigningDescription") }}</p>
      </div>
      <FluentButton v-if="!showForm" tone="primary" @click="showForm = true">{{
        t("settingsNewKey")
      }}</FluentButton>
    </header>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <section v-else class="box" aria-labelledby="signing-key-list-title">
      <header class="box-header">
        <h3 id="signing-key-list-title">{{ t("settingsKeyList") }}</h3>
        <StatusBadge>{{ keys.length }}</StatusBadge>
      </header>
      <p v-if="!keys.length" class="settings-empty">{{ t("settingsNoKeys") }}</p>
      <ul v-else class="settings-list">
        <li v-for="key in keys" :key="key.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ key.title }}
              <StatusBadge :tone="key.revokedAt ? 'neutral' : 'success'">{{
                t(key.revokedAt ? "settingsRevoked" : "settingsRegistered")
              }}</StatusBadge>
            </div>
            <div class="row-meta">
              <code>{{ key.fingerprint }}</code>
              <span>{{ d(key.createdAt, "short") }}</span>
            </div>
          </div>
          <ConfirmButton
            v-if="!key.revokedAt"
            :label="t('settingsRevoke')"
            :prompt="t('confirmRevokeSigningKey')"
            :disabled="busy"
            @confirm="revoke(key)"
          />
        </li>
      </ul>
    </section>
    <form
      v-if="showForm && !challenge"
      class="box"
      aria-labelledby="signing-key-new-title"
      @submit.prevent="start"
    >
      <header class="box-header">
        <h3 id="signing-key-new-title">{{ t("settingsNewKey") }}</h3>
      </header>
      <div class="box-form form-stack">
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
        <div class="form-actions">
          <FluentButton :disabled="busy" @click="showForm = false">{{ t("cancel") }}</FluentButton>
          <FluentButton type="submit" tone="primary" :busy="busy">{{
            t("settingsCreateChallenge")
          }}</FluentButton>
        </div>
      </div>
    </form>
    <form
      v-else-if="showForm"
      class="box"
      aria-labelledby="signing-key-proof-title"
      @submit.prevent="finish"
    >
      <header class="box-header">
        <h3 id="signing-key-proof-title">{{ t("settingsProofTitle") }}</h3>
      </header>
      <div v-if="challenge" class="box-form form-stack">
        <p>{{ t("settingsProofDescription") }}</p>
        <div class="settings-actions">
          <FluentButton @click="download">{{ t("settingsDownloadChallenge") }}</FluentButton>
        </div>
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
        <div class="form-actions">
          <FluentButton :disabled="busy" @click="challenge = null">{{ t("back") }}</FluentButton>
          <FluentButton type="submit" tone="primary" :busy="busy">{{
            t("settingsFinishKey")
          }}</FluentButton>
        </div>
      </div>
    </form>
  </section>
</template>
