<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { GitTagNameSchema, TAG_LIST_LIMIT } from "../../../../packages/contracts/src/index";
import type { Repository, RepositoryTag } from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import TextField from "./TextField.vue";
import "../styles/releases.css";

const props = defineProps<{
  repository: Repository;
  branches: string[];
  selectedBranch: string;
}>();
const emit = defineEmits<{ select: [name: string]; changed: [] }>();
const { t } = useI18n();
const tags = ref<RepositoryTag[]>([]);
const truncated = ref(false);
const expanded = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const name = ref("");
const message = ref("");
const source = ref("");
const deleting = ref("");

const sourceBranch = computed(() =>
  props.branches.includes(source.value) ? source.value : props.selectedBranch
);
const nameAvailable = computed(() => {
  const value = name.value.trim();
  return GitTagNameSchema.safeParse(value).success && !tags.value.some((tag) => tag.name === value);
});

const errorKeys: Readonly<Record<string, string>> = {
  tag_exists: "tagErrorExists",
  bad_request: "tagErrorInvalid",
  refs_changed: "tagErrorChanged",
};
function failure(cause: unknown): void {
  error.value =
    cause instanceof ApiError && cause.code && errorKeys[cause.code]
      ? t(errorKeys[cause.code])
      : errorMessage(cause, t);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const page = await api.repositoryTags(props.repository.id);
    tags.value = page.items;
    truncated.value = page.truncated;
  } catch (cause) {
    failure(cause);
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (!nameAvailable.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api.createRepositoryTag(props.repository.id, {
      name: name.value.trim(),
      target: sourceBranch.value,
      ...(message.value.trim() ? { message: message.value.trim() } : {}),
    });
    name.value = "";
    message.value = "";
    await load();
    emit("changed");
  } catch (cause) {
    failure(cause);
  } finally {
    saving.value = false;
  }
}

async function remove(tag: RepositoryTag): Promise<void> {
  deleting.value = tag.name;
  error.value = "";
  try {
    await api.deleteRepositoryTag(props.repository.id, { name: tag.name, expectedOid: tag.oid });
    await load();
    emit("changed");
  } catch (cause) {
    failure(cause);
  } finally {
    deleting.value = "";
  }
}

watch(() => props.repository.id, load, { immediate: true });
</script>

<template>
  <div class="tag-management">
    <FluentButton
      type="button"
      tone="secondary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
      ><AppIcon name="tag" />{{ t("tagManage") }} ({{ tags.length
      }}{{ truncated ? "+" : "" }})</FluentButton
    >
    <section v-if="expanded" class="tag-panel box" :aria-label="t('tagListTitle')">
      <div class="box-header">
        <AppIcon name="tag" />
        <h2>{{ t("tagListTitle") }}</h2>
      </div>
      <p v-if="loading" class="muted">{{ t("loading") }}</p>
      <p v-else-if="!tags.length" class="muted">{{ t("tagNone") }}</p>
      <div v-for="tag in tags" :key="tag.name" class="tag-row">
        <FluentButton
          type="button"
          tone="subtle"
          class="tag-name"
          @click="emit('select', tag.name)"
        >
          <strong>{{ tag.name }}</strong>
          <StatusBadge v-if="tag.annotated">{{ t("tagAnnotated") }}</StatusBadge>
        </FluentButton>
        <code>{{ tag.commitOid.slice(0, 8) }}</code>
        <ConfirmButton
          size="small"
          tone="secondary"
          :label="t('delete')"
          :accessible-name="t('tagDelete', { name: tag.name })"
          :prompt="t('tagDeletePrompt', { name: tag.name })"
          :busy="deleting === tag.name"
          :disabled="Boolean(deleting) || saving"
          @confirm="remove(tag)"
        />
      </div>
      <p v-if="truncated" class="muted">{{ t("tagTruncated", { count: TAG_LIST_LIMIT }) }}</p>
      <form class="tag-create" @submit.prevent="create">
        <TextField v-model="name" maxlength="200" required>{{ t("tagName") }}</TextField>
        <SelectField
          :model-value="sourceBranch"
          :label="t('tagTarget')"
          :hint="t('tagTargetHint', { name: sourceBranch })"
          @update:model-value="source = $event"
        >
          <option v-for="branch in branches" :key="branch" :value="branch">{{ branch }}</option>
        </SelectField>
        <TextField v-model="message" maxlength="5000" :hint="t('tagMessageHint')">{{
          t("tagMessage")
        }}</TextField>
        <FluentButton
          type="submit"
          tone="primary"
          :busy="saving"
          :disabled="saving || !nameAvailable"
          >{{ t("tagCreate") }}</FluentButton
        >
      </form>
      <NoticeBar v-if="error" intent="error" class="tag-error">{{ error }}</NoticeBar>
    </section>
  </div>
</template>
