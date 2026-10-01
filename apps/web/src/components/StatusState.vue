<script setup lang="ts">
defineProps<{ loading?: boolean; error?: string; empty?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="loading" class="state" role="status">
    <span class="spinner" aria-hidden="true" />{{ $t("loading") }}
  </div>
  <div v-else-if="error" class="state error" role="alert">
    <strong>{{ $t("apiError") }}</strong>
    <button class="btn" @click="$emit('retry')">{{ $t("retry") }}</button>
  </div>
  <div v-else-if="empty" class="state">{{ $t("empty") }}</div>
</template>
