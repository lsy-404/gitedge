import type { GitRef } from "../../../../packages/contracts/src/forge";

export interface LineRange {
  start: number;
  end: number;
}

const MAX_LINE = 10_000_000;
const anchorPattern = /^#L(\d{1,8})(?:-L(\d{1,8}))?$/;

/** Parses `#L10` or `#L10-L20`; a reversed range is normalized and a zero line is rejected. */
export function parseLineAnchor(hash: string): LineRange | null {
  const match = anchorPattern.exec(hash);
  if (!match) return null;
  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  if (first < 1 || second < 1 || first > MAX_LINE || second > MAX_LINE) return null;
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

export function formatLineAnchor(range: LineRange): string {
  return range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`;
}

/** A plain click selects one line; a shift click extends from the current anchor line. */
export function nextLineSelection(
  current: LineRange | null,
  line: number,
  extend: boolean
): LineRange {
  if (!extend || !current) return { start: line, end: line };
  const anchor = current.start;
  return { start: Math.min(anchor, line), end: Math.max(anchor, line) };
}

/** Full commit id for a branch, tag or commit ref, or null when the ref is unknown. */
export function resolveCommitOid(refs: readonly GitRef[], refName: string): string | null {
  if (/^[0-9a-f]{40}$/.test(refName)) return refName;
  for (const prefix of ["refs/heads/", "refs/tags/"]) {
    const ref = refs.find((item) => item.name === prefix + refName);
    if (ref) return ref.peeledOid ?? ref.oid;
  }
  return null;
}

export interface PermalinkInput {
  owner: string;
  repository: string;
  path: string;
  commitOid: string;
  range: LineRange | null;
}

/** Blob location pinned to a commit id so the line range keeps pointing at the same text. */
export function permalinkLocation(input: PermalinkInput): {
  path: string;
  query: { ref: string };
  hash: string;
} {
  const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
  return {
    path: `/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/blob/${encodedPath}`,
    query: { ref: input.commitOid },
    hash: input.range ? formatLineAnchor(input.range) : "",
  };
}

/**
 * Splits highlight.js output into one HTML fragment per source line, closing and reopening spans
 * that cross a line break. Matches the line count of `splitLines` for the same text.
 */
export function splitHighlightedLines(html: string): string[] {
  if (html === "") return [];
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let cursor = 0;
  for (const match of html.matchAll(/<span\b[^>]*>|<\/span>|\n/g)) {
    current += html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[0] === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else {
      if (match[0] === "</span>") open.pop();
      else open.push(match[0]);
      current += match[0];
    }
  }
  current += html.slice(cursor);
  if (!html.endsWith("\n")) lines.push(current);
  return lines;
}
