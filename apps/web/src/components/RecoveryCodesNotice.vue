<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import NoticeBar from "./NoticeBar.vue";

const props = defineProps<{ codes: string[] }>();
defineEmits<{ dismiss: [] }>();
const { t } = useI18n();
const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.codes.join("\n"));
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

function download(): void {
  const url = URL.createObjectURL(
    new Blob([`${props.codes.join("\n")}\n`], { type: "text/plain;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "gitedge-recovery-codes.txt";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section class="box" aria-labelledby="recovery-codes-reveal-title">
    <header class="box-header">
      <h3 id="recovery-codes-reveal-title">{{ t("recoveryCodesTitle") }}</h3>
    </header>
    <div class="box-form form-stack">
      <NoticeBar intent="warning">{{ t("recoveryCodesOnce") }}</NoticeBar>
      <ul class="security-codes" :aria-label="t('recoveryCodesTitle')">
        <li v-for="code in codes" :key="code">
          <code>{{ code }}</code>
        </li>
      </ul>
      <div class="settings-actions">
        <FluentButton type="button" tone="secondary" @click="copy">{{
          copied ? t("settingsCopied") : t("settingsCopy")
        }}</FluentButton>
        <FluentButton type="button" tone="secondary" @click="download">{{
          t("recoveryCodesDownload")
        }}</FluentButton>
        <FluentButton type="button" tone="subtle" @click="$emit('dismiss')">{{
          t("recoveryCodesSaved")
        }}</FluentButton>
      </div>
    </div>
  </section>
</template>
