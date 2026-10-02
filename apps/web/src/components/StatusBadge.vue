<script setup lang="ts">
/** Small state label. Tones map to Fluent badge colors. */
withDefaults(defineProps<{ tone?: "neutral" | "success" | "danger" | "brand" | "warning" }>(), {
  tone: "neutral",
});

const colors = {
  neutral: "subtle",
  success: "success",
  danger: "danger",
  brand: "brand",
  warning: "warning",
} as const;
</script>

<template>
  <fluent-badge appearance="tint" shape="rounded" :color="colors[tone]"><slot /></fluent-badge>
</template>
