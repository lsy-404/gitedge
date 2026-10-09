export interface FuzzyMatch {
  path: string;
  score: number;
  /** Positions in `path` of the matched characters. */
  indices: number[];
}

const SEPARATORS = new Set(["/", "_", "-", ".", " "]);
const CONSECUTIVE_BONUS = 1;
const GAP_PENALTY = 0.01;
const LENGTH_PENALTY = 0.005;
const NEG = Number.NEGATIVE_INFINITY;

function wordBonus(path: string, index: number, basenameStart: number): number {
  const previous = index === 0 ? "/" : (path[index - 1] ?? "");
  const current = path[index] ?? "";
  let bonus = SEPARATORS.has(previous) ? 0.8 : 0;
  if (previous !== previous.toUpperCase() && current !== current.toLowerCase()) bonus = 0.6;
  return bonus + (index >= basenameStart ? 0.3 : 0);
}

/**
 * Case-insensitive subsequence match scored for word starts, consecutive runs and basename hits.
 * Returns null when the query is not a subsequence of the path.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const needle = query.toLowerCase().replaceAll(/\s+/g, "");
  const haystack = path.toLowerCase();
  const rows = needle.length;
  const columns = haystack.length;
  if (rows === 0) return { path, score: 0, indices: [] };
  if (rows > columns) return null;
  let probe = 0;
  for (const char of haystack) if (char === needle[probe] && ++probe === rows) break;
  if (probe < rows) return null;

  const basenameStart = path.lastIndexOf("/") + 1;
  // matched[j][i]: best score with needle[j] matched exactly at haystack[i]; best[j][i]: with
  // needle[j] matched at or before i.
  const matched = Array.from({ length: rows }, () => new Float64Array(columns).fill(NEG));
  const best = Array.from({ length: rows }, () => new Float64Array(columns).fill(NEG));
  for (let j = 0; j < rows; j++) {
    for (let i = j; i < columns; i++) {
      if (haystack[i] === needle[j]) {
        const bonus = wordBonus(path, i, basenameStart);
        if (j === 0) matched[j][i] = 1 + bonus;
        else if (i > 0) {
          const consecutive = matched[j - 1][i - 1] + 1 + CONSECUTIVE_BONUS;
          const gapped = best[j - 1][i - 1] + 1 + bonus;
          matched[j][i] = Math.max(consecutive, gapped);
        }
      }
      const carried = i > 0 ? best[j][i - 1] - GAP_PENALTY : NEG;
      best[j][i] = Math.max(matched[j][i], carried);
    }
  }
  const total = best[rows - 1][columns - 1];
  if (total === NEG) return null;

  const indices: number[] = [];
  let i = columns - 1;
  for (let j = rows - 1; j >= 0; j--) {
    while (i >= 0 && matched[j][i] !== best[j][i]) i--;
    indices.unshift(i);
    i--;
  }
  return { path, score: total - columns * LENGTH_PENALTY, indices };
}

/** Best matches first; an empty query keeps the original order. */
export function fuzzyFilter(query: string, paths: readonly string[], limit: number): FuzzyMatch[] {
  if (query.trim() === "")
    return paths.slice(0, limit).map((path) => ({ path, score: 0, indices: [] }));
  const results: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) results.push(match);
  }
  results.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1)
  );
  return results.slice(0, limit);
}
