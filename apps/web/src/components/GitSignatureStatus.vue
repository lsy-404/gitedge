<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { GitSignature } from "../../../../packages/contracts/src/signatures";
import { api } from "../lib/api";
import StatusBadge from "./StatusBadge.vue";
/** Verifies a commit (`refName` and `oid`) or an annotated tag (`tagName`) on request. */
const props = defineProps<{
  repositoryId: string;
  refName?: string;
  oid?: string;
  tagName?: string;
}>();
const { t } = useI18n();
const result = ref<GitSignature | null>(null),
  busy = ref(false),
  error = ref("");
let requestVersion = 0;
const labels = {
  unsigned: "settingsSignatureUnsigned",
  valid: "settingsSignatureValid",
  invalid: "settingsSignatureInvalid",
  unknown_key: "settingsSignatureUnknown",
  revoked_key: "settingsSignatureRevoked",
  email_mismatch: "settingsSignatureEmailMismatch",
  unsupported: "settingsSignatureUnsupported",
};
const formatNames = { openpgp: "OpenPGP", ssh: "SSH", x509: "X.509" };
function tone(status: GitSignature["status"]) {
  if (status === "valid") return "success";
  if (status === "invalid" || status === "revoked_key" || status === "email_mismatch")
    return "danger";
  return "neutral";
}
async function verify() {
  const version = ++requestVersion;
  busy.value = true;
  error.value = "";
  try {
    const response = props.tagName
      ? await api.tagSignature(props.repositoryId, props.tagName)
      : await api.commitSignature(props.repositoryId, props.refName ?? "", props.oid ?? "");
    if (version === requestVersion) result.value = response;
  } catch {
    if (version === requestVersion) error.value = t("settingsSignatureUnavailable");
  } finally {
    if (version === requestVersion) busy.value = false;
  }
}
watch(
  () => [props.repositoryId, props.refName, props.oid, props.tagName],
  () => {
    ++requestVersion;
    result.value = null;
    error.value = "";
    busy.value = false;
  }
);
</script>
<template>
  <section class="commit-signature">
    <FluentButton v-if="!result" :busy="busy" @click="verify">{{
      tagName ? t("settingsVerifyTagSignature") : t("settingsVerifySignature")
    }}</FluentButton>
    <template v-else
      ><StatusBadge :tone="tone(result.status)">{{
        t(labels[result.status], { format: result.format ? formatNames[result.format] : "" })
      }}</StatusBadge
      ><span v-if="result.signer"
        >{{ t("settingsSignatureAttribution") }}
        <strong>{{ result.signer.identifier }}</strong></span
      ><code v-if="result.fingerprint">{{ result.fingerprint }}</code>
      <p class="muted" :title="t('settingsSignatureMeaning')">
        {{ t("settingsSignatureMeaning") }}
      </p></template
    >
    <p v-if="error" role="status">{{ error }}</p>
  </section>
</template>
<style scoped>
.commit-signature {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-3) 0;
  font-size: var(--font-size-meta);
}
.commit-signature p {
  width: 100%;
  margin: 0;
}
.commit-signature code {
  overflow-wrap: anywhere;
}
</style>
