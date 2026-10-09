<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField } from "@platform-kit/fluent/vue";

const props = defineProps<{
  expected: string;
  actionLabel: string;
  busy?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ confirm: [] }>();
const { t } = useI18n();
const typed = ref("");
const matches = computed(() => typed.value === props.expected);

function confirm() {
  if (!matches.value || props.busy || props.disabled) return;
  emit("confirm");
}
</script>

<template>
  <div class="type-to-confirm">
    <FluentField
      :model-value="typed"
      :label="t('typeToConfirmPrompt', { name: expected })"
      :disabled="disabled || busy"
      autocomplete="off"
      @update:model-value="typed = $event"
      @keydown.enter.prevent="confirm"
    />
    <FluentButton
      type="button"
      tone="danger"
      :disabled="!matches || disabled"
      :busy="busy"
      @click="confirm"
    >
      {{ actionLabel }}
    </FluentButton>
  </div>
</template>

<style scoped>
.type-to-confirm {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  min-width: 0;
}
</style>
