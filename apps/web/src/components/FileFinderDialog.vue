<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { GitFileList } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { fuzzyFilter } from "../lib/fuzzy";
import AppIcon from "./AppIcon.vue";
import StatusState from "./StatusState.vue";

const RESULT_LIMIT = 50;
const props = defineProps<{ open: boolean; repositoryId: string; refName: string }>();
const emit = defineEmits<{ "update:open": [value: boolean]; select: [path: string] }>();
const { t } = useI18n();
const query = ref("");
const active = ref(0);
const files = ref<GitFileList | null>(null);
const loading = ref(false);
const error = ref("");
const input = ref<HTMLInputElement | null>(null);
let loadedKey = "";
let loadVersion = 0;

const results = computed(() =>
  files.value ? fuzzyFilter(query.value, files.value.paths, RESULT_LIMIT) : []
);
const rows = computed(() =>
  results.value.map((match) => {
    const matched = new Set(match.indices);
    const parts: { text: string; match: boolean }[] = [];
    for (let index = 0; index < match.path.length; index++) {
      const char = match.path[index] ?? "";
      const isMatch = matched.has(index);
      const last = parts.at(-1);
      if (last && last.match === isMatch) last.text += char;
      else parts.push({ text: char, match: isMatch });
    }
    return { path: match.path, parts };
  })
);
const activeId = computed(() =>
  rows.value.length ? `file-finder-option-${active.value}` : undefined
);

async function load() {
  const key = `${props.repositoryId}\0${props.refName}`;
  if (key === loadedKey && files.value) return;
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const list = await api.fileList(props.repositoryId, props.refName);
    if (version !== loadVersion) return;
    files.value = list;
    loadedKey = key;
  } catch (cause) {
    if (version === loadVersion) error.value = errorMessage(cause, t);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
function close() {
  emit("update:open", false);
}
function choose(path: string) {
  emit("select", path);
  close();
}
function move(delta: number) {
  const count = rows.value.length;
  if (count) active.value = (active.value + delta + count) % count;
  void nextTick(() =>
    document.getElementById(activeId.value ?? "")?.scrollIntoView({ block: "nearest" })
  );
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") move(1);
  else if (event.key === "ArrowUp") move(-1);
  else if (event.key === "Home") active.value = 0;
  else if (event.key === "End") active.value = Math.max(0, rows.value.length - 1);
  else if (event.key === "Enter") {
    const row = rows.value[active.value];
    if (row) choose(row.path);
  } else return;
  event.preventDefault();
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    query.value = "";
    active.value = 0;
    void load();
    void nextTick(() => nextTick(() => input.value?.focus()));
  },
  { immediate: true }
);
watch(query, () => (active.value = 0));
watch([() => props.repositoryId, () => props.refName], () => {
  files.value = null;
  loadedKey = "";
  if (props.open) void load();
});
</script>

<template>
  <FluentDialog
    :open="open"
    :label="t('goToFile')"
    close-on-outside
    @update:open="emit('update:open', $event)"
  >
    <template #title>{{ t("goToFile") }}</template>
    <div class="file-finder">
      <label class="search-field">
        <AppIcon name="search" />
        <input
          ref="input"
          v-model="query"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-controls="file-finder-results"
          aria-expanded="true"
          :aria-activedescendant="activeId"
          :aria-label="t('goToFile')"
          :placeholder="t('codeSearchPlaceholder')"
          @keydown="onKeydown"
        />
      </label>
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
      <template v-if="files && !loading && !error">
        <p v-if="files.truncated" class="finder-hint">
          {{ t("fileFinderTruncated", { count: files.paths.length }) }}
        </p>
        <ul id="file-finder-results" class="finder-results" role="listbox" :aria-label="t('files')">
          <li
            v-for="(row, index) in rows"
            :id="`file-finder-option-${index}`"
            :key="row.path"
            class="finder-result"
            role="option"
            :aria-selected="index === active"
            @click="choose(row.path)"
            @mousemove="active = index"
          >
            <AppIcon name="file" />
            <span
              ><template v-for="(part, partIndex) in row.parts" :key="partIndex"
                ><mark v-if="part.match">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template></template
              ></span
            >
          </li>
        </ul>
        <p v-if="!rows.length" class="state">{{ t("fileFinderEmpty") }}</p>
        <span class="visually-hidden" role="status" aria-live="polite">{{
          t("fileFinderResults", { count: rows.length })
        }}</span>
      </template>
      <p class="finder-hint">{{ t("fileFinderHint") }}</p>
    </div>
  </FluentDialog>
</template>
