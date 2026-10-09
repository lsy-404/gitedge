<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { GitCommitDetail, Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import CommitSignatureStatus from "./CommitSignatureStatus.vue";
import DiffViewer from "./DiffViewer.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repository: Repository; oid: string }>();
const { t, d } = useI18n();
const route = useRoute();
const detail = ref<GitCommitDetail | null>(null);
const loading = ref(false);
const error = ref("");
let version = 0;

const base = computed(() => `/${props.repository.owner}/${props.repository.name}`);
const subject = computed(() => detail.value?.commit.message.split("\n")[0] ?? "");
const body = computed(() => detail.value?.commit.message.split("\n").slice(1).join("\n").trim());
const signatureRef = computed(() => String(route.query.ref || props.repository.defaultBranch));

async function load() {
  const current = ++version;
  loading.value = true;
  error.value = "";
  detail.value = null;
  try {
    const result = await api.commitDetail(props.repository.id, props.oid);
    if (current === version) detail.value = result;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}

watch([() => props.repository.id, () => props.oid], load, { immediate: true });
</script>

<template>
  <section class="box commit-page">
    <div class="box-header">
      <AppIcon name="commit" />
      <h2>{{ detail ? subject : t("commitDetails") }}</h2>
      <RouterLink class="btn btn-sm" :to="{ path: base, query: { ref: oid } }"
        ><AppIcon name="folder" />{{ t("commitBrowseFiles") }}</RouterLink
      >
    </div>
    <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    <div v-if="detail && !loading && !error" class="commit-page-body">
      <p v-if="body" class="commit-page-message">{{ body }}</p>
      <div class="commit-page-meta">
        <span>{{
          t("commitAuthored", {
            name: detail.commit.author.name,
            date: d(detail.commit.author.timestamp * 1000, "long"),
          })
        }}</span>
        <code>{{ detail.commit.oid }}</code>
        <span v-if="detail.commit.parents.length" class="commit-page-meta">
          {{ t("parents") }}
          <RouterLink
            v-for="parent in detail.commit.parents"
            :key="parent"
            :to="{
              path: `${base}/commit/${parent}`,
              query: route.query.ref ? { ref: signatureRef } : {},
            }"
            >{{ parent.slice(0, 8) }}</RouterLink
          >
        </span>
        <CommitSignatureStatus
          :repository-id="repository.id"
          :ref-name="signatureRef"
          :oid="detail.commit.oid"
        />
      </div>
      <NoticeBar v-if="detail.truncated" intent="warning">{{ t("commitTruncated") }}</NoticeBar>
      <p v-if="!detail.files.length" class="state">{{ t("commitNoChanges") }}</p>
      <p v-else class="muted">{{ detail.files.length }} {{ t("changedFiles") }}</p>
      <article v-for="change in detail.files" :key="change.path" class="compare-file">
        <header class="compare-file-header">
          <AppIcon name="file" />
          <strong>{{ change.path }}</strong>
          <StatusBadge>{{ change.type }}</StatusBadge>
        </header>
        <DiffViewer v-if="change.patch" :patch="change.patch" :path="change.path" />
        <p v-else class="muted">
          {{ change.binary ? t("binaryPreviewUnavailable") : t("diffTooLarge") }}
        </p>
      </article>
    </div>
  </section>
</template>

<style src="../styles/code.css"></style>
