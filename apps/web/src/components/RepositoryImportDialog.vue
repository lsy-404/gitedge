<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RepositoryImport } from "../../../../packages/contracts/src/imports";
import { repositoryNameFromUrl } from "../../../../packages/contracts/src/import-url";
import { RepositorySlugSchema } from "../../../../packages/contracts/src/repository-controls";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import { oneOf } from "../ui/formEvents";

const POLL_INTERVAL_MS = 2000;
const visibilities = ["private", "public"] as const;
const props = defineProps<{
  open: boolean;
  owners: ReadonlyArray<{ value: string; label: string }>;
  defaultOwner: string;
}>();
const emit = defineEmits<{ close: []; imported: [] }>();
const { t } = useI18n();

const sourceUrl = ref("");
const name = ref("");
const nameEdited = ref(false);
const description = ref("");
const owner = ref(props.defaultOwner);
const visibility = ref<"private" | "public">("private");
const saving = ref(false);
const formError = ref("");
const job = ref<RepositoryImport | null>(null);
const unfinished = ref<RepositoryImport[]>([]);
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

const running = computed(() => job.value?.status === "queued" || job.value?.status === "running");
const repositoryPath = computed(() =>
  job.value?.status === "succeeded" ? `/${job.value.owner}/${job.value.slug}` : ""
);

function stopPolling() {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

function reset() {
  stopPolling();
  sourceUrl.value = "";
  name.value = "";
  nameEdited.value = false;
  description.value = "";
  owner.value = props.defaultOwner;
  visibility.value = "private";
  saving.value = false;
  formError.value = "";
  job.value = null;
  unfinished.value = [];
}

async function loadUnfinished() {
  const current = generation;
  try {
    const jobs = await api.repositoryImports();
    if (current === generation && !job.value) unfinished.value = jobs ?? [];
  } catch {
    unfinished.value = [];
  }
}

function resume(next: RepositoryImport) {
  stopPolling();
  formError.value = "";
  job.value = next;
  if (next.status === "queued" || next.status === "running") poll(next.id);
}

function poll(id: string) {
  const current = generation;
  timer = setTimeout(async () => {
    try {
      const next = await api.repositoryImport(id);
      if (current !== generation || !next) return;
      job.value = next;
      if (next.status === "succeeded") emit("imported");
      else if (next.status !== "failed") poll(id);
    } catch (cause) {
      if (current !== generation) return;
      formError.value = errorMessage(cause, t);
      poll(id);
    }
  }, POLL_INTERVAL_MS);
}

async function start() {
  const parsedName = RepositorySlugSchema.safeParse(name.value);
  if (!parsedName.success) {
    formError.value = t("repositoryNameInvalid");
    return;
  }
  saving.value = true;
  formError.value = "";
  try {
    const created = await api.importRepository({
      sourceUrl: sourceUrl.value,
      owner: owner.value,
      slug: parsedName.data,
      visibility: visibility.value,
      description: description.value,
    });
    if (created) resume(created);
  } catch (cause) {
    formError.value = errorMessage(cause, t, { 409: "nameTaken", 422: "importInvalidUrl" });
  } finally {
    saving.value = false;
  }
}

async function retry() {
  if (!job.value) return;
  formError.value = "";
  try {
    const next = await api.retryRepositoryImport(job.value.id);
    if (next) resume(next);
  } catch (cause) {
    formError.value = errorMessage(cause, t);
  }
}

function close() {
  emit("close");
}

watch(sourceUrl, (value) => {
  if (!nameEdited.value) name.value = repositoryNameFromUrl(value);
});
watch(
  () => props.open,
  (open) => {
    if (!open && !running.value) reset();
    else if (open && !job.value) void loadUnfinished();
  },
  { immediate: true }
);
watch(
  () => props.defaultOwner,
  (value) => {
    if (!job.value) owner.value = value;
  }
);
onBeforeUnmount(stopPolling);
</script>

<template>
  <FluentDialog :open="open" :label="t('importRepository')" close-on-outside @close="close">
    <template #title>
      <h2>{{ t("importRepository") }}</h2>
    </template>
    <div v-if="job" class="form-stack" aria-live="polite">
      <p class="mono">{{ job.owner }}/{{ job.slug }}</p>
      <NoticeBar v-if="running" intent="info">{{
        job.status === "queued"
          ? t("importQueued")
          : job.progress === "starting"
            ? t("importStarting")
            : t("importRunning")
      }}</NoticeBar>
      <NoticeBar v-else-if="job.status === 'succeeded'" intent="success">{{
        t("importSucceeded")
      }}</NoticeBar>
      <NoticeBar v-else intent="error">{{
        t(`importError_${job.errorCode ?? "import_failed"}`)
      }}</NoticeBar>
      <NoticeBar v-if="formError" intent="error">{{ formError }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="button" @click="close">{{ t("close") }}</FluentButton>
        <FluentButton v-if="job.status === 'failed'" type="button" tone="primary" @click="retry">{{
          t("importRetry")
        }}</FluentButton>
        <RouterLink
          v-if="repositoryPath"
          class="btn btn-primary"
          :to="repositoryPath"
          @click="close"
          >{{ t("importOpenRepository") }}</RouterLink
        >
      </div>
    </div>
    <form v-else class="form-stack" @submit.prevent="start">
      <p class="muted">{{ t("importRepositoryHint") }}</p>
      <section v-if="unfinished.length" class="form-stack" :aria-label="t('importUnfinished')">
        <h3>{{ t("importUnfinished") }}</h3>
        <div v-for="item in unfinished" :key="item.id" class="form-actions">
          <span class="mono">{{ item.owner }}/{{ item.slug }}</span>
          <FluentButton type="button" @click="resume(item)">{{ t("importView") }}</FluentButton>
        </div>
      </section>
      <TextField v-model="sourceUrl" type="url" required>{{ t("importSourceUrl") }}</TextField>
      <SelectField v-model="owner" :label="t('repositoryOwner')" required>
        <option v-for="option in owners" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </SelectField>
      <TextField v-model="name" required @update:model-value="nameEdited = true">{{
        t("repositoryName")
      }}</TextField>
      <TextField v-model="description">{{ t("description") }}</TextField>
      <SelectField
        :model-value="visibility"
        :label="t('visibility')"
        @update:model-value="visibility = oneOf(visibilities, $event, 'private')"
      >
        <option value="private">{{ t("private") }}</option>
        <option value="public">{{ t("public") }}</option>
      </SelectField>
      <NoticeBar v-if="formError" intent="error">{{ formError }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="button" @click="close">{{ t("cancel") }}</FluentButton>
        <FluentButton type="submit" tone="primary" :disabled="saving">{{
          saving ? t("loading") : t("importStart")
        }}</FluentButton>
      </div>
    </form>
  </FluentDialog>
</template>
