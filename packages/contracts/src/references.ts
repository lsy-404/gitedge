/** Maximum issue references honored per text, keeping merge batches bounded. */
export const MAX_ISSUE_REFERENCES = 50;

export interface IssueReference {
  number: number;
  /** The reference follows a closing keyword (closes, fixes, resolves). */
  closes: boolean;
}

export interface RepositoryIdentity {
  owner: string;
  slug: string;
}

const CLOSING_KEYWORD = /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)$/i;
const REFERENCE =
  /(?<![\w/.-])(?:(?<keyword>[A-Za-z]+)[ \t]*:?[ \t]+)?(?:(?<owner>[A-Za-z0-9][A-Za-z0-9-]*)\/(?<slug>[A-Za-z0-9_.-]+))?#(?<number>[1-9]\d{0,8})(?![\w-])/g;

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * Issue references in free text. Cross-repository references are ignored; owner/repo#n counts
 * only for the same repository. Code spans and fenced blocks are skipped.
 */
export function parseIssueReferences(
  text: string,
  repository: RepositoryIdentity
): IssueReference[] {
  const found = new Map<number, boolean>();
  for (const match of withoutCode(text).matchAll(REFERENCE)) {
    const groups = match.groups;
    if (!groups?.number) continue;
    if (groups.owner && groups.slug) {
      if (
        groups.owner.toLowerCase() !== repository.owner.toLowerCase() ||
        groups.slug.toLowerCase() !== repository.slug.toLowerCase()
      )
        continue;
    }
    const number = Number(groups.number);
    const closes = Boolean(groups.keyword && CLOSING_KEYWORD.test(groups.keyword));
    found.set(number, (found.get(number) ?? false) || closes);
    if (found.size >= MAX_ISSUE_REFERENCES) break;
  }
  return [...found].map(([number, closes]) => ({ number, closes }));
}

/** Issue numbers a set of texts asks to close. */
export function closingIssueNumbers(
  texts: readonly string[],
  repository: RepositoryIdentity
): number[] {
  const numbers = new Set<number>();
  for (const text of texts)
    for (const reference of parseIssueReferences(text, repository))
      if (reference.closes) numbers.add(reference.number);
  return [...numbers].slice(0, MAX_ISSUE_REFERENCES);
}

const TASK_REFERENCE = /(?<![\w/.-])task[ \t]+#(?<number>[1-9]\d{0,8})(?![\w-])/i;

/** The task number a pull request title or body names with "task #n"; the first mention wins. */
export function parseTaskReference(text: string): number | null {
  const match = TASK_REFERENCE.exec(withoutCode(text));
  return match?.groups?.number ? Number(match.groups.number) : null;
}
