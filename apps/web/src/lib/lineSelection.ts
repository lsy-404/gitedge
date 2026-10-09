import { computed, watch, type ComputedRef, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { formatLineAnchor, nextLineSelection, parseLineAnchor, type LineRange } from "./codeAnchor";

export interface RevealableLines {
  reveal(): void;
}

/**
 * Keeps the line range in the URL hash. The range scrolls into view when the lines first render
 * and when the hash is changed from outside; clicking a line number does not scroll.
 */
export function useLineSelection(lines: Ref<RevealableLines | null>): {
  selection: ComputedRef<LineRange | null>;
  select: (line: number, extend: boolean) => void;
} {
  const route = useRoute();
  const router = useRouter();
  const selection = computed(() => parseLineAnchor(route.hash));
  let ownHash = "";

  function select(line: number, extend: boolean) {
    ownHash = formatLineAnchor(nextLineSelection(selection.value, line, extend));
    void router.replace({ path: route.path, query: route.query, hash: ownHash });
  }
  watch(lines, (current, previous) => {
    if (current && !previous) current.reveal();
  });
  watch(
    () => route.hash,
    (hash) => {
      if (hash !== ownHash) lines.value?.reveal();
      ownHash = "";
    }
  );
  return { selection, select };
}
