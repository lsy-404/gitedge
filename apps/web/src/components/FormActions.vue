<script setup lang="ts">
import NoticeBar from "./NoticeBar.vue";

defineProps<{ saving: boolean; error: string }>();
defineEmits<{ cancel: [] }>();
</script>

<template>
  <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  <div class="form-actions">
    <FluentButton type="button" @click="$emit('cancel')">{{ $t("cancel") }}</FluentButton>
    <FluentButton type="submit" tone="primary" :disabled="saving">
      {{ saving ? $t("loading") : $t("create") }}
    </FluentButton>
  </div>
</template>
