<script setup lang="ts">
import NoticeBar from "./NoticeBar.vue";

defineProps<{ saving: boolean; error: string }>();
defineEmits<{ cancel: [] }>();
</script>

<template>
  <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  <div class="form-actions">
    <fluent-button type="button" @click="$emit('cancel')">{{ $t("cancel") }}</fluent-button>
    <fluent-button type="submit" appearance="primary" :disabled="saving">
      {{ saving ? $t("loading") : $t("create") }}
    </fluent-button>
  </div>
</template>
