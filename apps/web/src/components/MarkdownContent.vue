<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown, type MarkdownRepository } from "../lib/markdown";
import "../styles/markdown.css";
const props = defineProps<{
  source: string;
  baseUrl?: string;
  allowImages?: boolean;
  mentions?: boolean;
  /** Links #n references to issues of this repository. */
  repository?: MarkdownRepository;
}>();
const rendered = computed(() =>
  renderMarkdown(props.source, props.baseUrl, props.allowImages, {
    mentions: props.mentions,
    repository: props.repository,
  })
);
</script>
<template><div class="markdown-body" v-html="rendered" /></template>
