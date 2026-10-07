<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { ApiError, api } from "../lib/api";
import type { AgentProfile } from "../../../../packages/contracts/src/agents";
import AppIcon from "../components/AppIcon.vue";
import StatusState from "../components/StatusState.vue";
import "../styles/workspace.css";

const { t } = useI18n();
const route = useRoute();
const profile = ref<AgentProfile | null>(null);
const loading = ref(true);
const error = ref("");
const owner = computed(() => String(route.params.owner ?? ""));
const handle = computed(() => String(route.params.handle ?? "").replace(/^@/, ""));
let loadVersion = 0;
async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  profile.value = null;
  try {
    const result = await api.agentProfile(owner.value, handle.value);
    if (version === loadVersion) profile.value = result;
  } catch (cause) {
    if (version !== loadVersion) return;
    error.value =
      cause instanceof ApiError && cause.status === 404 ? t("agentProfileNotFound") : t("apiError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
watch([owner, handle], () => void load(), { immediate: true });
</script>

<template>
  <section class="workspace-page">
    <section class="box agent-profile-card">
      <StatusState
        v-if="loading || error"
        :loading="loading"
        :error="error"
        :empty="false"
        @retry="load"
      />
      <template v-else-if="profile">
        <div class="agent-profile-avatar"><AppIcon name="agent" :size="30" /></div>
        <div>
          <p class="eyebrow">{{ t("agentProfile") }}</p>
          <h1>{{ profile.name }}</h1>
          <p class="muted">{{ profile.owner }}/@{{ profile.handle }}</p>
          <p>{{ profile.description || t("noDescription") }}</p>
        </div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.agent-profile-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  width: min(820px, calc(100% - 2 * var(--page-gutter)));
  margin: var(--space-6) auto 0;
  padding: var(--space-5);
}
.agent-profile-card > .state,
.agent-profile-card > .state-error {
  flex: 1;
}
.agent-profile-card > div:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-profile-avatar {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.agent-profile-card h1 {
  margin: 0;
}
.agent-profile-card p + p,
.agent-profile-card h1 + p {
  margin-top: var(--space-1);
}
</style>
