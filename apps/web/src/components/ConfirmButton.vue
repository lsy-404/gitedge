<script setup lang="ts">
import { nextTick, ref, useId, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    label: string;
    accessibleName?: string;
    size?: "small" | "medium";
    prompt: string;
    confirmLabel?: string;
    tone?: "danger" | "secondary" | "subtle" | "primary";
    disabled?: boolean;
    busy?: boolean;
  }>(),
  {
    tone: "danger",
    confirmLabel: undefined,
    accessibleName: undefined,
    size: undefined,
    disabled: false,
    busy: false,
  }
);
const emit = defineEmits<{ confirm: [] }>();

const { t } = useI18n();
const armed = ref(false);
const promptId = useId();
const root = useTemplateRef<HTMLElement>("root");

async function focusFirstButton(): Promise<void> {
  await nextTick();
  root.value?.querySelector<HTMLButtonElement>("button")?.focus();
}

async function arm(): Promise<void> {
  if (props.disabled || props.busy) return;
  armed.value = true;
  await focusFirstButton();
}

async function cancel(): Promise<void> {
  armed.value = false;
  await focusFirstButton();
}

async function confirm(): Promise<void> {
  if (props.disabled || props.busy) return;
  armed.value = false;
  emit("confirm");
  await focusFirstButton();
}

watch(
  () => props.disabled || props.busy,
  (blocked) => {
    if (blocked) armed.value = false;
  }
);
defineExpose({ arm });
</script>

<template>
  <span ref="root" class="confirm-button">
    <FluentButton
      v-if="!armed"
      type="button"
      :tone="tone"
      :busy="busy"
      :aria-label="accessibleName"
      :size="size"
      :disabled="disabled"
      @click="arm"
    >
      {{ label }}
    </FluentButton>
    <span
      v-else
      class="confirm-button-group"
      role="group"
      :aria-label="prompt"
      @keydown.esc.stop="cancel"
    >
      <FluentButton
        type="button"
        :tone="tone"
        :size="size"
        :disabled="disabled || busy"
        :aria-describedby="promptId"
        @click="confirm"
      >
        {{ confirmLabel ?? t("confirmAction") }}
      </FluentButton>
      <FluentButton type="button" :size="size" @click="cancel">{{ t("cancel") }}</FluentButton>
      <span :id="promptId" class="muted">{{ prompt }}</span>
    </span>
  </span>
</template>

<style scoped>
.confirm-button {
  display: inline-flex;
  max-width: 100%;
}
.confirm-button-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
