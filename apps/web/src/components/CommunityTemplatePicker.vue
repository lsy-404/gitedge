<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RepositoryCommunityFile } from "../lib/api";
import { api } from "../lib/api";
import { communitySourceUrl, isCommunityTruncated } from "../lib/community";
import { FluentButton } from "@platform-kit/fluent/vue";
import MarkdownContent from "./MarkdownContent.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

type TemplateKind = "issue" | "pull-request";
interface ParsedIssueTemplate {
  name: string;
  about: string;
  title: string;
  body: string;
}
interface TemplateChoice {
  file: RepositoryCommunityFile;
  name: string;
  about: string;
  title: string;
  body: string;
  unsupported: boolean;
  truncated: boolean;
}

const props = defineProps<{
  repositoryId: string;
  refName: string;
  kind: TemplateKind;
}>();
const emit = defineEmits<{ select: [value: { title: string; body: string }] }>();
const { t } = useI18n();
const files = ref<RepositoryCommunityFile[]>([]);
const responseTruncated = ref(false);
const loading = ref(true);
const error = ref("");
let loadVersion = 0;

function yamlScalar(source: string, key: string): string {
  const match = source.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"));
  if (!match) return "";
  const value = match[1] ?? "";
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "'" && last === "'") || (first === '"' && last === '"')
    ? value.slice(1, -1)
    : value;
}

function parseIssueTemplate(content: string): ParsedIssueTemplate {
  const frontmatter = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const metadata = frontmatter?.[1] ?? "";
  return {
    name: yamlScalar(metadata, "name"),
    about: yamlScalar(metadata, "about"),
    title: yamlScalar(metadata, "title"),
    body: frontmatter ? content.slice(frontmatter[0].length) : content,
  };
}

const choices = computed<TemplateChoice[]>(() => {
  const templates = props.kind === "issue" ? files.value : files.value.slice(0, 1);
  return templates.map((file) => {
    const parsed = props.kind === "issue" ? parseIssueTemplate(file.content) : null;
    return {
      file,
      name: parsed?.name || file.title,
      about: parsed?.about || "",
      title: parsed?.title || "",
      body: parsed?.body ?? file.content,
      unsupported:
        props.kind === "issue" && (/\.ya?ml$/i.test(file.path) || /form/i.test(file.kind)),
      truncated: isCommunityTruncated(file),
    };
  });
});
const emptyMessage = computed(() =>
  props.kind === "issue" ? t("communityNoIssueTemplates") : t("communityNoPullRequestTemplate")
);

function select(choice: TemplateChoice): void {
  if (choice.unsupported || choice.truncated) return;
  emit("select", { title: choice.title, body: choice.body });
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  files.value = [];
  responseTruncated.value = false;
  try {
    const result = await api.repositoryCommunity(props.repositoryId, props.refName);
    if (version !== loadVersion) return;
    files.value =
      props.kind === "issue"
        ? result.issueTemplates
        : result.pullRequestTemplate
          ? [result.pullRequestTemplate]
          : [];
    responseTruncated.value = result.truncated;
  } catch {
    if (version === loadVersion) error.value = t("communityTemplateLoadError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => [props.repositoryId, props.refName, props.kind], load, { immediate: true });
</script>

<template>
  <section class="community-template-picker" :aria-label="t('communityTemplateSelect')">
    <h3>
      {{
        props.kind === "issue" ? t("communityIssueTemplates") : t("communityPullRequestTemplate")
      }}
    </h3>
    <p class="template-picker-hint">{{ t("communityTemplateHint") }}</p>
    <p v-if="props.kind === 'issue'" class="template-picker-hint muted">
      {{ t("communityFrontmatterHint") }}
    </p>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <NoticeBar v-if="responseTruncated" intent="warning">{{ t("communityTruncated") }}</NoticeBar>
      <p v-if="!choices.length" class="muted">{{ emptyMessage }}</p>
      <ul v-else class="template-choice-list">
        <li v-for="choice in choices" :key="`${choice.file.repositoryId}:${choice.file.path}`">
          <div class="template-choice-heading">
            <div>
              <strong>{{ choice.name }}</strong>
              <p v-if="choice.about" class="muted">{{ choice.about }}</p>
              <p class="template-source muted">
                <span v-if="choice.file.inherited">
                  {{
                    t("communityInherited", {
                      owner: choice.file.owner,
                      repository: choice.file.repository,
                    })
                  }}
                  ·
                </span>
                <a :href="communitySourceUrl(choice.file, props.refName)">{{
                  t("communitySource")
                }}</a>
              </p>
            </div>
            <FluentButton
              type="button"
              tone="primary"
              :disabled="choice.unsupported || choice.truncated"
              @click="select(choice)"
            >
              {{ t("communityTemplateSelected") }}
            </FluentButton>
          </div>
          <p v-if="choice.unsupported" class="template-limit" role="status">
            {{ t("communityUnsupportedForm") }}
          </p>
          <p v-else-if="choice.truncated" class="template-limit" role="status">
            {{ t("communityTruncatedTemplate") }}
          </p>
          <details v-else class="template-preview">
            <summary>{{ t("communityTemplatePreview") }}</summary>
            <MarkdownContent
              :source="choice.body"
              :base-url="communitySourceUrl(choice.file, props.refName)"
            />
          </details>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.community-template-picker {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.community-template-picker h3,
.template-picker-hint,
.template-choice-heading p {
  margin: 0;
}
.template-picker-hint,
.template-choice-heading p {
  font-size: 13px;
}
.template-choice-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.template-choice-list li {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.template-choice-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.template-choice-heading > div {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.template-source {
  overflow-wrap: anywhere;
}
.template-limit {
  margin: 0;
  color: var(--warning-text, var(--muted));
  font-size: 13px;
}
.template-preview {
  max-height: 50vh;
  overflow: auto;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.template-preview summary {
  margin-bottom: 12px;
  color: var(--muted);
  cursor: pointer;
}
@media (max-width: 700px) {
  .template-choice-heading {
    display: grid;
  }
}
</style>
