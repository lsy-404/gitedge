<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { Usage } from "../../../../packages/contracts/src/ops";
import { api, errorMessage, formatBytes } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

const { t } = useI18n();
const usage = ref<Usage | null>(null);
const loading = ref(true);
const loadingError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadingError.value = "";
  try {
    usage.value = await api.usage();
  } catch (cause) {
    loadingError.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsUsage") }}</h2>
        <p>{{ t("settingsUsageDescription") }}</p>
      </div>
      <FluentButton type="button" tone="subtle" :busy="loading" @click="load">
        {{ t("refresh") }}
      </FluentButton>
    </header>
    <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <section v-else-if="usage" class="box" :aria-label="t('settingsUsage')">
      <ul class="settings-list">
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageRepositories") }}</div>
            <div class="row-meta">
              <span>{{
                t("usageUsedOfLimit", {
                  used: usage.repositories.used,
                  limit: usage.repositories.limit,
                })
              }}</span>
            </div>
          </div>
          <progress
            class="progress-bar"
            :aria-label="t('usageRepositories')"
            :value="usage.repositories.used"
            :max="usage.repositories.limit"
          ></progress>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageStorage") }}</div>
            <div class="row-meta">
              <span v-if="usage.storage.usedBytes === null">{{
                t("usageStorageNotMeasured", { limit: formatBytes(usage.storage.limitBytes) })
              }}</span>
              <span v-else>{{
                t("usageUsedOfLimit", {
                  used: formatBytes(usage.storage.usedBytes),
                  limit: formatBytes(usage.storage.limitBytes),
                })
              }}</span>
            </div>
          </div>
          <progress
            v-if="usage.storage.usedBytes !== null"
            class="progress-bar"
            :aria-label="t('usageStorage')"
            :value="usage.storage.usedBytes"
            :max="usage.storage.limitBytes"
          ></progress>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageRequestRate") }}</div>
            <div class="row-meta">
              <span>{{ t("usageRequestRateValue", { count: usage.rpm }) }}</span>
            </div>
          </div>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usagePushLimit") }}</div>
            <div class="row-meta">
              <span>{{ formatBytes(usage.maxPushBytes) }}</span>
            </div>
          </div>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageRepositorySize") }}</div>
            <div class="row-meta">
              <span>{{ formatBytes(usage.maxRepositoryBytes) }}</span>
            </div>
          </div>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageGroup") }}</div>
            <div class="row-meta">
              <span>{{ usage.groupKey }}</span>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>
