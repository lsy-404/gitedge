<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../lib/markdown";
import "../styles/markdown.css";
const props = defineProps<{ source: string; baseUrl?: string }>();
const rendered = computed(() => renderMarkdown(props.source, props.baseUrl));
</script>
<template><div class="markdown-body" v-html="rendered" /></template>
