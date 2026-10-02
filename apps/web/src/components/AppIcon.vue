<script setup lang="ts">
import { computed } from "vue";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleHelp,
  Cloud,
  CodeXml,
  Copy,
  Diff,
  Download,
  Eye,
  ExternalLink,
  File,
  FileText,
  Filter,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  History,
  House,
  Link,
  ListTodo,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircleMore,
  Plus,
  Search,
  Settings,
  Tag,
  Target,
  Terminal,
  UserRound,
  X,
} from "@lucide/vue";

const props = defineProps<{ name: string; size?: number }>();
const icons = {
  activity: Activity,
  agent: Bot,
  alert: AlertCircle,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowUpRight: ArrowUpRight,
  book: BookOpen,
  branch: GitBranch,
  check: Check,
  checkCircle: CircleCheck,
  chevron: ChevronDown,
  chevronRight: ChevronRight,
  circle: Circle,
  cloud: Cloud,
  code: CodeXml,
  commit: GitCommitHorizontal,
  copy: Copy,
  diff: Diff,
  discussion: MessageCircleMore,
  download: Download,
  eye: Eye,
  file: File,
  filter: Filter,
  folder: Folder,
  gear: Settings,
  github: GitBranch,
  home: House,
  issue: CircleDot,
  link: Link,
  lock: LockKeyhole,
  markdown: FileText,
  menu: Menu,
  organization: Building2,
  person: UserRound,
  plus: Plus,
  pr: GitPullRequest,
  repo: CodeXml,
  search: Search,
  signOut: LogOut,
  tag: Tag,
  target: Target,
  task: ListTodo,
  terminal: Terminal,
  wiki: BookOpen,
  clock: History,
  close: X,
  external: ExternalLink,
  help: CircleHelp,
} as const;
const icon = computed(() => icons[props.name as keyof typeof icons] ?? CircleHelp);
</script>

<script lang="ts">
export type IconName =
  | "activity"
  | "agent"
  | "alert"
  | "arrowDown"
  | "arrowLeft"
  | "arrowUpRight"
  | "book"
  | "branch"
  | "check"
  | "checkCircle"
  | "chevron"
  | "chevronRight"
  | "circle"
  | "cloud"
  | "code"
  | "commit"
  | "copy"
  | "diff"
  | "discussion"
  | "download"
  | "eye"
  | "external"
  | "file"
  | "filter"
  | "folder"
  | "gear"
  | "github"
  | "home"
  | "issue"
  | "link"
  | "lock"
  | "markdown"
  | "menu"
  | "organization"
  | "person"
  | "plus"
  | "pr"
  | "repo"
  | "search"
  | "signOut"
  | "tag"
  | "target"
  | "task"
  | "terminal"
  | "wiki"
  | "clock"
  | "close"
  | "help";
</script>

<template>
  <component :is="icon" class="icon" :size="size ?? 16" :stroke-width="1.8" aria-hidden="true" />
</template>
