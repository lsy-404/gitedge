<script setup lang="ts">
/** Inline status message. `error` is announced assertively, everything else politely. */
withDefaults(defineProps<{ intent?: "error" | "success" | "info" | "warning" }>(), {
  intent: "info",
});
</script>

<template>
  <FluentNotice :tone="intent === 'error' ? 'danger' : intent">
    <slot />
    <span v-if="$slots.actions" class="notice-actions"><slot name="actions" /></span>
  </FluentNotice>
</template>
