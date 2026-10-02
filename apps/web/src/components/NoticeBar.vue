<script setup lang="ts">
/** Inline status message. `error` is announced assertively, everything else politely. */
withDefaults(defineProps<{ intent?: "error" | "success" | "info" | "warning" }>(), {
  intent: "info",
});
</script>

<template>
  <fluent-message-bar
    :intent="intent"
    shape="square"
    :role="intent === 'error' ? 'alert' : 'status'"
  >
    <slot />
  </fluent-message-bar>
</template>
