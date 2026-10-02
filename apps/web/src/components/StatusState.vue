<script setup lang="ts">
import NoticeBar from "./NoticeBar.vue";

defineProps<{ loading?: boolean; error?: string; empty?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="loading" class="state" role="status">
    <fluent-spinner size="small" />{{ $t("loading") }}
  </div>
  <div v-else-if="error" class="state-error">
    <NoticeBar intent="error">
      {{ error }}
      <fluent-button slot="actions" size="small" type="button" @click="$emit('retry')">{{
        $t("retry")
      }}</fluent-button>
    </NoticeBar>
  </div>
  <div v-else-if="empty" class="state">
    <slot name="empty">{{ $t("empty") }}</slot>
  </div>
</template>
