<script setup lang="ts">
defineProps<{ saving: boolean; error: string }>();
defineEmits<{ cancel: [] }>();
</script>

<template>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <div class="form-actions">
    <button type="button" class="btn" @click="$emit('cancel')">{{ $t("cancel") }}</button>
    <button class="btn primary" :disabled="saving">
      {{ saving ? $t("loading") : $t("create") }}
    </button>
  </div>
</template>
