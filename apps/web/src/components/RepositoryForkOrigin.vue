<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { Repository } from "../lib/api";
import { ApiError, api } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import "../styles/social.css";

const props = defineProps<{ repository: Repository }>();
const emit = defineEmits<{ synced: [] }>();
const { t } = useI18n();
const syncing = ref(false);
const message = ref("");
const failure = ref("");

const errorKeys: Readonly<Record<string, string>> = {
  not_fast_forward: "forkSyncDiverged",
  repository_too_large: "forkSyncTooLarge",
  upstream_unavailable: "forkSyncUnavailable",
};
const parentPath = (origin: NonNullable<Repository["forkOf"]>) =>
  `/${encodeURIComponent(origin.owner)}/${encodeURIComponent(origin.name)}`;

async function sync(): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  message.value = "";
  failure.value = "";
  const branch = props.repository.defaultBranch;
  try {
    const result = await api.syncFork(props.repository.id, branch);
    message.value = t(result.status === "up_to_date" ? "forkSyncUpToDate" : "forkSyncDone", {
      branch,
    });
    if (result.status === "fast_forwarded") emit("synced");
  } catch (cause) {
    failure.value =
      cause instanceof ApiError && cause.code && errorKeys[cause.code]
        ? t(errorKeys[cause.code])
        : t("forkSyncError");
  } finally {
    syncing.value = false;
  }
}
</script>

<template>
  <div v-if="repository.forkOf" class="repository-fork-origin">
    <AppIcon name="fork" :size="14" />
    <span
      >{{ t("forkedFrom") }}
      <RouterLink :to="parentPath(repository.forkOf)"
        >{{ repository.forkOf.owner }}/{{ repository.forkOf.name }}</RouterLink
      ></span
    >
    <template v-if="repository.canWrite && !repository.archived">
      <button type="button" class="btn btn-sm" :disabled="syncing" @click="sync">
        {{ syncing ? t("forkSyncing") : t("forkSync") }}
      </button>
      <RouterLink
        class="btn btn-sm"
        :to="{
          path: `${parentPath(repository.forkOf)}/pulls`,
          query: {
            new: '1',
            headRepositoryId: repository.id,
            headFork: `${repository.owner}/${repository.name}`,
            head: repository.defaultBranch,
          },
        }"
        ><AppIcon name="pr" />{{ t("forkContribute") }}</RouterLink
      >
    </template>
    <span v-if="message" role="status">{{ message }}</span>
    <span v-if="failure" class="social-error" role="alert">{{ failure }}</span>
  </div>
</template>
