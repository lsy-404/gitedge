<script setup lang="ts">
import { useI18n } from "vue-i18n";
import AppIcon from "../components/AppIcon.vue";
import StatusState from "../components/StatusState.vue";

const { t } = useI18n();
</script>
<template>
  <section class="repository-access">
    <StatusState empty>
      <template #empty>
        <AppIcon name="file" :size="48" />
        <h1>{{ t("notFoundTitle") }}</h1>
        <p>{{ t("notFoundText") }}</p>
        <RouterLink class="btn" to="/">{{ t("notFoundHome") }}</RouterLink>
      </template>
    </StatusState>
  </section>
</template>
