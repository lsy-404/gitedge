<script lang="ts">
import add from "@fluentui/svg-icons/icons/add_16_regular.svg?raw";
import branch from "@fluentui/svg-icons/icons/branch_16_regular.svg?raw";
import code from "@fluentui/svg-icons/icons/code_16_regular.svg?raw";
import clipboardTask from "@fluentui/svg-icons/icons/clipboard_task_16_regular.svg?raw";
import copy from "@fluentui/svg-icons/icons/copy_16_regular.svg?raw";
import issue from "@fluentui/svg-icons/icons/record_16_regular.svg?raw";
import lock from "@fluentui/svg-icons/icons/lock_closed_16_regular.svg?raw";
import pullRequest from "@fluentui/svg-icons/icons/branch_request_16_regular.svg?raw";
import repo from "@fluentui/svg-icons/icons/book_16_regular.svg?raw";
import search from "@fluentui/svg-icons/icons/search_16_regular.svg?raw";
import settings from "@fluentui/svg-icons/icons/settings_16_regular.svg?raw";
import target from "@fluentui/svg-icons/icons/target_16_regular.svg?raw";
import wiki from "@fluentui/svg-icons/icons/book_open_16_regular.svg?raw";

const sources = {
  plus: add,
  branch,
  code,
  copy,
  issue,
  lock,
  pr: pullRequest,
  repo,
  search,
  settings,
  target,
  task: clipboardTask,
  wiki,
};

export type IconName = keyof typeof sources;

/** Fluent icon files are one or more `<path d>` elements on a 16px grid. */
function pathData(svg: string): string[] {
  return Array.from(svg.matchAll(/\sd="([^"]+)"/g), (match) => match[1]);
}

const icons = Object.fromEntries(
  Object.entries(sources).map(([name, svg]) => [name, pathData(svg)])
);
</script>

<script setup lang="ts">
defineProps<{ name: IconName; size?: number }>();
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in icons[name]" :key="index" :d="d" />
  </svg>
</template>
