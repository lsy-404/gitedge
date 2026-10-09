<script setup lang="ts">
import { nextTick, onMounted, ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";
import TextAreaField from "./TextAreaField.vue";

defineProps<{ label: string; busy: boolean; hasPendingReview: boolean }>();
const emit = defineEmits<{ submit: [body: string, pending: boolean]; cancel: [] }>();
const { t } = useI18n();
const body = ref("");
const root = useTemplateRef<HTMLElement>("root");

onMounted(async () => {
  await nextTick();
  root.value?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
});
function send(pending: boolean) {
  if (!body.value.trim()) return;
  emit("submit", body.value, pending);
}
</script>

<template>
  <form
    ref="root"
    class="review-composer form-stack"
    @submit.prevent="send(false)"
    @keydown.esc.stop="emit('cancel')"
  >
    <TextAreaField v-model="body" rows="3" :label="label" :hint="t('rangeHint')" required />
    <div class="form-actions">
      <FluentButton type="submit" tone="primary" size="small" :disabled="busy || !body.trim()">
        {{ t("singleComment") }}
      </FluentButton>
      <FluentButton type="button" size="small" :disabled="busy || !body.trim()" @click="send(true)">
        {{ hasPendingReview ? t("addReviewComment") : t("startReview") }}
      </FluentButton>
      <FluentButton type="button" tone="subtle" size="small" @click="emit('cancel')">
        {{ t("cancel") }}
      </FluentButton>
    </div>
  </form>
</template>

<style scoped>
.review-composer {
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  color: var(--fg-default);
}
</style>
