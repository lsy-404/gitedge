<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { parsePatch } from "diff";
const props = defineProps<{ patch: string; path?: string }>();
const { t } = useI18n();
interface DiffLine {
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
  kind: string;
}
const hunks = computed(() => {
  try {
    return parsePatch(props.patch).flatMap((file) =>
      file.hunks.map((hunk) => {
        let oldLine = hunk.oldStart,
          newLine = hunk.newStart;
        const lines: DiffLine[] = hunk.lines.map((text) => {
          const kind = text.startsWith("+")
            ? "addition"
            : text.startsWith("-")
              ? "deletion"
              : text.startsWith("\\")
                ? "note"
                : "context";
          return {
            text,
            kind,
            oldNumber: kind === "addition" || kind === "note" ? null : oldLine++,
            newNumber: kind === "deletion" || kind === "note" ? null : newLine++,
          };
        });
        return {
          header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          lines,
        };
      })
    );
  } catch {
    return [];
  }
});
</script>
<template>
  <div class="diff-viewer diff-preview">
    <table v-if="hunks.length" :aria-label="path">
      <thead class="visually-hidden">
        <tr>
          <th scope="col">{{ t("diffOldLine") }}</th>
          <th scope="col">{{ t("diffNewLine") }}</th>
          <th scope="col">{{ t("diffChange") }}</th>
        </tr>
      </thead>
      <tbody v-for="(hunk, index) in hunks" :key="index">
        <tr class="diff-hunk">
          <td></td>
          <td></td>
          <td>
            <code>{{ hunk.header }}</code>
          </td>
        </tr>
        <tr v-for="(line, lineIndex) in hunk.lines" :key="lineIndex" :class="`diff-${line.kind}`">
          <td class="diff-number">{{ line.oldNumber }}</td>
          <td class="diff-number">{{ line.newNumber }}</td>
          <td class="diff-code">
            <code>{{ line.text }}</code>
          </td>
        </tr>
      </tbody>
    </table>
    <pre v-else>{{ patch }}</pre>
  </div>
</template>
<style scoped>
.diff-viewer {
  width: 100%;
  max-height: none;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-top: 0;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  background: var(--bg-canvas);
}
table {
  min-width: 100%;
  border-collapse: collapse;
  font: 12px/20px var(--font-mono);
}
td {
  padding: 0 10px;
  vertical-align: top;
}
.diff-number {
  width: 44px;
  min-width: 44px;
  color: var(--fg-muted);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border-muted);
}
.diff-code {
  width: 100%;
}
code {
  font: inherit;
  white-space: pre;
  color: inherit;
}
.diff-addition {
  background: light-dark(#dafbe1, #12261e);
}
.diff-addition .diff-number {
  background: light-dark(#aceebb, #143e26);
}
.diff-deletion {
  background: light-dark(#ffebe9, #311c1f);
}
.diff-deletion .diff-number {
  background: light-dark(#ffd8d3, #522329);
}
.diff-hunk {
  color: var(--fg-muted);
  background: light-dark(#ddf4ff, #182b40);
}
.diff-hunk td {
  padding-top: 5px;
  padding-bottom: 5px;
}
pre {
  margin: 0;
  padding: 12px;
}
</style>
