<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField } from "@platform-kit/fluent/vue";
import type { AdminRepository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const { t, d } = useI18n();
const repositories = ref<AdminRepository[]>([]);
const nextCursor = ref<string | null>(null);
const search = ref("");
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
let version = 0;

async function load(): Promise<void> {
  const current = ++version;
  loading.value = true;
  error.value = "";
  try {
    const page = await api.adminRepositories({ q: search.value.trim() || undefined });
    if (current !== version) return;
    repositories.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}

async function more(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await api.adminRepositories({
      q: search.value.trim() || undefined,
      cursor: nextCursor.value,
    });
    repositories.value = [...repositories.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="box" aria-labelledby="admin-repositories-title">
    <header class="box-header">
      <h2 id="admin-repositories-title">{{ t("adminRepositories") }}</h2>
    </header>
    <form class="box-form admin-search" @submit.prevent="load">
      <FluentField v-model="search" :label="t('adminSearchRepositories')" type="search" />
      <FluentButton type="submit">{{ t("search") }}</FluentButton>
    </form>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!repositories.length" class="settings-empty">{{ t("adminNoRepositories") }}</p>
      <ul v-else class="settings-list">
        <li v-for="repository in repositories" :key="repository.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ repository.owner }}/{{ repository.name }}
              <StatusBadge>{{
                repository.visibility === "public" ? t("public") : t("private")
              }}</StatusBadge>
              <StatusBadge v-if="repository.archived">{{ t("adminArchived") }}</StatusBadge>
              <StatusBadge v-if="repository.deletedAt" tone="danger">{{
                t("adminDeleted")
              }}</StatusBadge>
            </div>
            <div class="row-meta">
              <span>{{ t("adminCreatedBy", { name: repository.createdBy }) }}</span>
              <span>{{ d(repository.createdAt, "short") }}</span>
            </div>
          </div>
        </li>
      </ul>
      <div v-if="nextCursor" class="box-form">
        <FluentButton type="button" :busy="loadingMore" @click="more">{{
          t("auditLoadMore")
        }}</FluentButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: end;
}
</style>
