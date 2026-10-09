<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  MAX_REPOSITORY_TOPICS,
  RepositoryTopicSchema,
} from "../../../../packages/contracts/src/social";
import type { Repository } from "../lib/api";
import { api } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import TextField from "./TextField.vue";
import TopicChips from "./TopicChips.vue";
import "../styles/social.css";

const props = defineProps<{ repository: Repository }>();
const emit = defineEmits<{ saved: [topics: string[]] }>();
const { t } = useI18n();
const text = ref(props.repository.topics.join(" "));
const saving = ref(false);
const message = ref("");
const failure = ref("");

const parsed = computed(() => {
  const words = text.value.split(/[\s,]+/).filter(Boolean);
  const topics = [...new Set(words.map((word) => word.toLowerCase()))];
  const valid =
    topics.length <= MAX_REPOSITORY_TOPICS &&
    topics.every((topic) => RepositoryTopicSchema.safeParse(topic).success);
  return { topics, valid };
});

async function save(): Promise<void> {
  if (!parsed.value.valid || saving.value) return;
  saving.value = true;
  message.value = "";
  failure.value = "";
  try {
    const result = await api.setRepositoryTopics(props.repository.id, parsed.value.topics);
    text.value = result.topics.join(" ");
    message.value = t("topicsSaved");
    emit("saved", result.topics);
  } catch {
    failure.value = t("topicsError");
  } finally {
    saving.value = false;
  }
}
watch(
  () => props.repository.topics,
  (topics) => (text.value = topics.join(" "))
);
</script>

<template>
  <form class="topics-editor" @submit.prevent="save">
    <h3>{{ t("topicsTitle") }}</h3>
    <TextField v-model="text" :hint="t('topicsHint')">{{ t("topicsInput") }}</TextField>
    <TopicChips :topics="parsed.valid ? parsed.topics : []" />
    <NoticeBar v-if="!parsed.valid" intent="warning">{{ t("topicsInvalid") }}</NoticeBar>
    <NoticeBar v-if="failure" intent="error">{{ failure }}</NoticeBar>
    <NoticeBar v-if="message" intent="success">{{ message }}</NoticeBar>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit" :disabled="!parsed.valid || saving">
        {{ t("topicsSave") }}
      </button>
    </div>
  </form>
</template>
