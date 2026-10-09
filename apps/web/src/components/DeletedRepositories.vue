<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { DeletedRepository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import ConfirmButton from "./ConfirmButton.vue";
import TypeToConfirm from "./TypeToConfirm.vue";
import "../styles/workspace.css";

const emit = defineEmits<{ restored: [] }>();
const { t, d } = useI18n();
const items = ref<DeletedRepository[]>([]);
const busyId = ref("");
const purgingId = ref("");
const error = ref("");

function restorable(item: DeletedRepository): boolean {
  return !item.purging && item.purgeAfter > Date.now();
}

async function load() {
  try {
    items.value = (await api.deletedRepositories()).items;
  } catch {
    // The list is supplementary; the section stays hidden when it cannot be read.
    items.value = [];
  }
}

async function restore(item: DeletedRepository) {
  busyId.value = item.id;
  error.value = "";
  try {
    await api.restoreRepository(item.id);
    emit("restored");
    await load();
  } catch (cause) {
    error.value = errorMessage(cause, t, { 409: "lifecycleRestoreConflict" });
  } finally {
    busyId.value = "";
  }
}

async function purge(item: DeletedRepository) {
  busyId.value = item.id;
  error.value = "";
  try {
    await api.purgeRepository(item.id, `${item.owner}/${item.name}`);
    purgingId.value = "";
    await load();
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busyId.value = "";
  }
}

onMounted(load);
</script>

<template>
  <section v-if="items.length" class="box deleted-repositories">
    <div class="box-header workspace-panel-heading">
      <div>
        <h2>{{ t("lifecycleDeletedTitle") }}</h2>
        <p class="muted">{{ t("lifecycleDeletedHint") }}</p>
      </div>
    </div>
    <div v-for="item in items" :key="item.id" class="box-row deleted-repository-row">
      <div class="deleted-repository-copy">
        <span class="repository-name">{{ item.owner }} / {{ item.name }}</span>
        <span class="muted">{{
          restorable(item)
            ? t("lifecycleDeletedUntil", { date: d(item.purgeAfter, "short") })
            : t("lifecycleDeletedPurging")
        }}</span>
      </div>
      <ConfirmButton
        size="small"
        tone="secondary"
        :label="t('lifecycleRestore')"
        :accessible-name="`${t('lifecycleRestore')} · ${item.owner}/${item.name}`"
        :prompt="t('lifecycleRestorePrompt')"
        :confirm-label="t('lifecycleRestore')"
        :disabled="!restorable(item) || Boolean(busyId)"
        @confirm="restore(item)"
      />
      <TypeToConfirm
        v-if="purgingId === item.id"
        :expected="`${item.owner}/${item.name}`"
        :action-label="t('lifecyclePurgeNow')"
        :busy="busyId === item.id"
        @confirm="purge(item)"
      />
      <FluentButton
        v-else
        type="button"
        size="small"
        tone="danger"
        :disabled="Boolean(busyId)"
        @click="purgingId = item.id"
      >
        {{ t("lifecyclePurgeNow") }}
      </FluentButton>
    </div>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  </section>
</template>

<style scoped>
.deleted-repository-row {
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.deleted-repository-copy {
  display: grid;
  flex: 1 1 12rem;
  min-width: 0;
}
</style>
