<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { LineRange } from "../lib/codeAnchor";
import { escapeHtml } from "../lib/markdown";

export interface BlameGutterRow {
  summary: string;
  author: string;
  age: string;
  /** Null for lines older than the inspected history. */
  href: string | null;
  title: string;
}

const props = defineProps<{
  /** One highlighted HTML fragment per source line. */
  lines: readonly string[];
  label: string;
  selection: LineRange | null;
  wrap: boolean;
  tabSize: number;
  /** Gutter rows keyed by the first line of each blame hunk. */
  blame?: ReadonlyMap<number, BlameGutterRow>;
}>();
const emit = defineEmits<{ select: [line: number, extend: boolean] }>();
const { t } = useI18n();
const router = useRouter();
const root = ref<HTMLElement | null>(null);

function blameCell(line: number): string {
  if (!props.blame) return "";
  const row = props.blame.get(line);
  if (!row) return '<span class="blame-cell"></span>';
  const summary = escapeHtml(row.summary);
  const link = row.href
    ? `<a class="blame-summary" data-route="${escapeHtml(row.href)}" href="${escapeHtml(row.href)}">${summary}</a>`
    : `<span class="blame-summary">${summary}</span>`;
  return `<span class="blame-cell blame-start" title="${escapeHtml(row.title)}"><span class="blame-author">${escapeHtml(row.author)}</span>${link}<span class="blame-age">${escapeHtml(row.age)}</span></span>`;
}
const html = computed(() =>
  props.lines
    .map((line, index) => {
      const number = index + 1;
      const label = escapeHtml(t("lineLabel", { line: number }));
      return `<div class="code-line${props.blame?.has(number) ? " hunk-start" : ""}">${blameCell(number)}<a class="line-number" href="#L${number}" data-line="${number}" aria-label="${label}">${number}</a><span class="line-text">${line}</span></div>`;
    })
    .join("")
);

function applySelection() {
  const container = root.value;
  if (!container) return;
  for (const row of container.querySelectorAll(".code-line.selected"))
    row.classList.remove("selected");
  if (!props.selection) return;
  const last = Math.min(props.selection.end, props.lines.length);
  for (let line = props.selection.start; line <= last; line++)
    container.children.item(line - 1)?.classList.add("selected");
}

/** Scrolls the selected range into the middle of the viewport. */
function reveal() {
  if (!props.selection) return;
  void nextTick(() =>
    root.value?.children.item(props.selection ? props.selection.start - 1 : 0)?.scrollIntoView({
      block: "center",
    })
  );
}
defineExpose({ reveal });

function onClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const number = event.target.closest<HTMLAnchorElement>("a.line-number");
  if (number) {
    event.preventDefault();
    emit("select", Number(number.dataset.line), event.shiftKey);
    return;
  }
  const link = event.target.closest<HTMLAnchorElement>("a[data-route]");
  if (link?.dataset.route && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    void router.push(link.dataset.route);
  }
}

watch([html, () => props.selection], applySelection, { flush: "post" });
onMounted(applySelection);
</script>

<template>
  <div
    ref="root"
    class="code-lines"
    :class="{ 'code-wrapped': wrap, 'with-blame': blame }"
    tabindex="0"
    role="region"
    :aria-label="label"
    :style="{ tabSize }"
    @click="onClick"
    v-html="html"
  ></div>
</template>
