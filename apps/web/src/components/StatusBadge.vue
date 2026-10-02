<script setup lang="ts">
withDefaults(defineProps<{ tone?: "neutral" | "success" | "danger" | "brand" | "warning" }>(), {
  tone: "neutral",
});
</script>
<template>
  <span class="badge" :class="`badge-${tone}`"><slot /></span>
</template>
