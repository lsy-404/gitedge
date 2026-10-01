<script setup lang="ts">
defineProps<{ loading?: boolean; error?: string; empty?: boolean }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div v-if="loading" class="state" role="status">
    <span class="spinner" aria-hidden="true" />{{ $t("loading") }}
  </div>
  <div v-else-if="error" class="state error" role="alert">
    <strong>{{ error }}</strong
    ><button class="button ghost" @click="$emit('retry')">{{ $t("retry") }}</button>
  </div>
  <div v-else-if="empty" class="state">
    <span class="empty-dot" aria-hidden="true" /><slot name="empty">{{ $t("empty") }}</slot>
  </div>
</template>
