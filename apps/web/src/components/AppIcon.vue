<script lang="ts">
import plus from "@primer/octicons/build/svg/plus-16.svg?raw";
import branch from "@primer/octicons/build/svg/git-branch-16.svg?raw";
import code from "@primer/octicons/build/svg/code-16.svg?raw";
import copy from "@primer/octicons/build/svg/copy-16.svg?raw";
import issue from "@primer/octicons/build/svg/issue-opened-16.svg?raw";
import lock from "@primer/octicons/build/svg/lock-16.svg?raw";
import pr from "@primer/octicons/build/svg/git-pull-request-16.svg?raw";
import repo from "@primer/octicons/build/svg/repo-16.svg?raw";
import search from "@primer/octicons/build/svg/search-16.svg?raw";
import wiki from "@primer/octicons/build/svg/book-16.svg?raw";
import menu from "@primer/octicons/build/svg/three-bars-16.svg?raw";
import chevron from "@primer/octicons/build/svg/chevron-down-16.svg?raw";
import close from "@primer/octicons/build/svg/x-16.svg?raw";
import check from "@primer/octicons/build/svg/check-16.svg?raw";
import clock from "@primer/octicons/build/svg/history-16.svg?raw";
import tag from "@primer/octicons/build/svg/tag-16.svg?raw";
import file from "@primer/octicons/build/svg/file-16.svg?raw";
import folder from "@primer/octicons/build/svg/file-directory-fill-16.svg?raw";
import chevronRight from "@primer/octicons/build/svg/chevron-right-16.svg?raw";
import commit from "@primer/octicons/build/svg/git-commit-16.svg?raw";
import diff from "@primer/octicons/build/svg/diff-16.svg?raw";
import discussion from "@primer/octicons/build/svg/comment-discussion-16.svg?raw";
import gear from "@primer/octicons/build/svg/gear-16.svg?raw";
import agent from "@primer/octicons/build/svg/agent-16.svg?raw";
import cloud from "@primer/octicons/build/svg/cloud-16.svg?raw";
import terminal from "@primer/octicons/build/svg/terminal-16.svg?raw";
import person from "@primer/octicons/build/svg/person-16.svg?raw";
import organization from "@primer/octicons/build/svg/organization-16.svg?raw";
import arrowLeft from "@primer/octicons/build/svg/arrow-left-16.svg?raw";
import link from "@primer/octicons/build/svg/link-16.svg?raw";
import download from "@primer/octicons/build/svg/download-16.svg?raw";
import signOut from "@primer/octicons/build/svg/sign-out-16.svg?raw";
import filter from "@primer/octicons/build/svg/filter-16.svg?raw";
import arrowUpRight from "@primer/octicons/build/svg/arrow-up-right-16.svg?raw";
import eye from "@primer/octicons/build/svg/eye-16.svg?raw";
import markdown from "@primer/octicons/build/svg/markdown-16.svg?raw";
import alert from "@primer/octicons/build/svg/alert-16.svg?raw";
import checkCircle from "@primer/octicons/build/svg/check-circle-16.svg?raw";
import gitMerge from "@primer/octicons/build/svg/git-merge-16.svg?raw";
import circle from "@primer/octicons/build/svg/circle-16.svg?raw";
import home from "@primer/octicons/build/svg/home-16.svg?raw";
import book from "@primer/octicons/build/svg/book-16.svg?raw";
import github from "@primer/octicons/build/svg/mark-github-16.svg?raw";

const sources = {
  plus,
  branch,
  code,
  copy,
  issue,
  lock,
  pr,
  repo,
  search,
  wiki,
  menu,
  chevron,
  close,
  check,
  clock,
  tag,
  file,
  folder,
  chevronRight,
  commit,
  diff,
  discussion,
  gear,
  agent,
  cloud,
  terminal,
  person,
  organization,
  arrowLeft,
  link,
  download,
  signOut,
  filter,
  arrowUpRight,
  eye,
  markdown,
  alert,
  checkCircle,
  gitMerge,
  circle,
  home,
  book,
  github,
};
export type IconName = keyof typeof sources;
const icons = Object.fromEntries(
  Object.entries(sources).map(([name, svg]) => [
    name,
    Array.from(svg.matchAll(/\sd="([^"]+)"/g), (match) => match[1]),
  ])
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
