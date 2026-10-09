<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../lib/markdown";
import "../styles/markdown.css";
const props = defineProps<{
  source: string;
  baseUrl?: string;
  allowImages?: boolean;
  mentions?: boolean;
}>();
const rendered = computed(() =>
  renderMarkdown(props.source, props.baseUrl, props.allowImages, props.mentions)
);
</script>
<template><div class="markdown-body" v-html="rendered" /></template>
