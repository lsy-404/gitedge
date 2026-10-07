<script setup lang="ts">
import type { BadgeTone } from "../lib/tasks";

withDefaults(defineProps<{ tone?: BadgeTone }>(), { tone: "neutral" });
</script>
<template>
  <span class="badge" :class="`badge-${tone}`"><slot /></span>
</template>
