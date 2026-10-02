<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
defineProps<{
  to: RouteLocationRaw;
  button?: "primary" | "secondary" | "outline" | "subtle" | "transparent";
}>();
</script>
<template>
  <RouterLink
    :to="to"
    :class="
      button
        ? [
            'btn',
            {
              'btn-primary': button === 'primary',
              'btn-subtle': button === 'subtle' || button === 'transparent',
            },
          ]
        : undefined
    "
    ><slot
  /></RouterLink>
</template>
