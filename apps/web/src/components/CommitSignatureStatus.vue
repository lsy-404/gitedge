<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { CommitSignature } from "../../../../packages/contracts/src/signatures";
import { api } from "../lib/api";
import StatusBadge from "./StatusBadge.vue";
const props = defineProps<{ repositoryId: string; refName: string; oid: string }>();
const { t } = useI18n();
const result = ref<CommitSignature | null>(null),
  busy = ref(false),
  error = ref("");
let requestVersion = 0;
const labels = {
  unsigned: "settingsSignatureUnsigned",
  valid: "settingsSignatureValid",
  invalid: "settingsSignatureInvalid",
  unknown_key: "settingsSignatureUnknown",
  revoked_key: "settingsSignatureRevoked",
  unsupported: "settingsSignatureUnsupported",
};
async function verify() {
  const version = ++requestVersion;
  busy.value = true;
  error.value = "";
  try {
    const response = await api.commitSignature(props.repositoryId, props.refName, props.oid);
    if (version === requestVersion) result.value = response;
  } catch {
    if (version === requestVersion) error.value = t("settingsSignatureUnavailable");
  } finally {
    if (version === requestVersion) busy.value = false;
  }
}
watch(
  () => [props.repositoryId, props.refName, props.oid],
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
      t("settingsVerifySignature")
    }}</FluentButton>
    <template v-else
      ><StatusBadge
        :tone="
          result.status === 'valid'
            ? 'success'
            : result.status === 'invalid' || result.status === 'revoked_key'
              ? 'danger'
              : 'neutral'
        "
        >{{ t(labels[result.status]) }}</StatusBadge
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
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 0;
  font-size: 12px;
}
.commit-signature p {
  width: 100%;
  margin: 0;
}
.commit-signature code {
  overflow-wrap: anywhere;
}
</style>
