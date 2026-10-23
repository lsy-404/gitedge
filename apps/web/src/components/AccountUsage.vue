<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
const repositoryRows = computed(() =>
  usage.value
    ? [
        { label: "usageRepositories", ...usage.value.repositories },
        { label: "usagePublicRepositories", ...usage.value.publicRepositories },
        { label: "usagePrivateRepositories", ...usage.value.privateRepositories },
      ]
    : []
);
const storageRows = computed(() =>
  usage.value
    ? [
        { label: "usageStorage", ...usage.value.storage },
        { label: "usagePublicStorage", ...usage.value.publicStorage },
        { label: "usagePrivateStorage", ...usage.value.privateStorage },
      ]
    : []
);

function quotaValue(value: number, bytes = false): string {
  return value === -1 ? t("usageUnlimited") : bytes ? formatBytes(value) : String(value);
}

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
        <li v-for="row in repositoryRows" :key="row.label" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t(row.label) }}</div>
            <div class="row-meta">
              <span>{{
                t("usageUsedOfLimit", {
                  used: row.used,
                  limit: quotaValue(row.limit),
                })
              }}</span>
            </div>
          </div>
          <progress
            v-if="row.limit > 0"
            class="progress-bar"
            :aria-label="t(row.label)"
            :value="row.used"
            :max="row.limit"
          ></progress>
        </li>
        <li v-for="row in storageRows" :key="row.label" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t(row.label) }}</div>
            <div class="row-meta">
              <span v-if="row.usedBytes === null">{{
                t("usageStorageNotMeasured", { limit: quotaValue(row.limitBytes, true) })
              }}</span>
              <span v-else>{{
                t("usageUsedOfLimit", {
                  used: formatBytes(row.usedBytes),
                  limit: quotaValue(row.limitBytes, true),
                })
              }}</span>
            </div>
          </div>
          <progress
            v-if="row.usedBytes !== null && row.limitBytes > 0"
            class="progress-bar"
            :aria-label="t(row.label)"
            :value="row.usedBytes"
            :max="row.limitBytes"
          ></progress>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageRequestRate") }}</div>
            <div class="row-meta">
              <span>{{
                usage.rpm === -1
                  ? t("usageUnlimited")
                  : t("usageRequestRateValue", { count: usage.rpm })
              }}</span>
            </div>
          </div>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usagePushLimit") }}</div>
            <div class="row-meta">
              <span>{{ quotaValue(usage.maxPushBytes, true) }}</span>
            </div>
          </div>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageRepositorySize") }}</div>
            <div class="row-meta">
              <span>{{ quotaValue(usage.maxRepositoryBytes, true) }}</span>
            </div>
          </div>
        </li>
        <li class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">{{ t("usageBuiltinRunner") }}</div>
            <div class="row-meta">
              <span>{{
                usage.builtinRunner.enabled
                  ? t("usageRunnerAllowance", {
                      count: quotaValue(usage.builtinRunner.runsPerRepositoryPerHour),
                    })
                  : t("usageRunnerNotIncluded")
              }}</span>
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
      <p class="box-row row-meta">{{ t("usageStorageBudgetNote") }}</p>
    </section>
  </section>
</template>
