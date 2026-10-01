<script setup lang="ts">
export type IconName =
  | "repo"
  | "code"
  | "issue"
  | "issue-closed"
  | "pr"
  | "wiki"
  | "lock"
  | "copy"
  | "check"
  | "branch"
  | "plus"
  | "search";

defineProps<{ name: IconName; size?: number }>();
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'repo'">
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v9.5H4.5A1.5 1.5 0 0 0 3 13z" />
      <path d="M3 13a1.5 1.5 0 0 0 1.5 1.5H13v-3" />
    </template>
    <path v-else-if="name === 'code'" d="m5.5 4-3.5 4 3.5 4M10.5 4 14 8l-3.5 4" />
    <template v-else-if="name === 'issue'">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </template>
    <template v-else-if="name === 'issue-closed'">
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8.2 1.8 1.8 3.2-3.6" />
    </template>
    <template v-else-if="name === 'pr'">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V7a2 2 0 0 0-2-2H8" />
    </template>
    <template v-else-if="name === 'wiki'">
      <path d="M3 3a1 1 0 0 1 1-1h8.5v10.5H4.5A1.5 1.5 0 0 0 3 14z" />
      <path d="M3 14a1.5 1.5 0 0 0 1.5 1.5h8V12.5M6 5.5h4" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </template>
    <path v-else-if="name === 'check'" d="m3.5 8.5 3 3 6-7" />
    <template v-else-if="name === 'branch'">
      <circle cx="5" cy="3.5" r="1.6" />
      <circle cx="5" cy="12.5" r="1.6" />
      <circle cx="11" cy="5.5" r="1.6" />
      <path d="M5 5.1v5.8M11 7.1V8a2 2 0 0 1-2 2H5" />
    </template>
    <path v-else-if="name === 'plus'" d="M8 3v10M3 8h10" />
    <template v-else-if="name === 'search'">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </template>
  </svg>
</template>
