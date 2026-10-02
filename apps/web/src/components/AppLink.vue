<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";

/**
 * Router-aware Fluent link. Fluent renders its own anchor inside a shadow root, so navigation is
 * handed to the router on click while the real `href` keeps middle-click and copy-link working.
 * Without `button` it renders an inline text link; with it, a link styled as a Fluent button.
 */
defineOptions({ inheritAttrs: false });
defineProps<{
  to: RouteLocationRaw;
  button?: "primary" | "secondary" | "outline" | "subtle" | "transparent";
}>();
</script>

<template>
  <RouterLink v-slot="{ href, navigate, isActive }" :to="to" custom>
    <fluent-anchor-button
      v-if="button"
      v-bind="$attrs"
      :href="href"
      :appearance="isActive && button === 'subtle' ? 'secondary' : button"
      :aria-current="isActive ? 'page' : undefined"
      @click="navigate"
    >
      <slot />
    </fluent-anchor-button>
    <fluent-link v-else v-bind="$attrs" :inline="true" :href="href" @click="navigate"
      ><slot
    /></fluent-link>
  </RouterLink>
</template>
