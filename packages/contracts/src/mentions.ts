export const MAX_MENTIONS = 20;

export type Mention =
  | { readonly kind: "user"; readonly login: string; readonly start: number; readonly end: number }
  | {
      readonly kind: "agent";
      readonly owner: string;
      readonly handle: string;
      readonly start: number;
      readonly end: number;
    };

const LOGIN = "[A-Za-z0-9][A-Za-z0-9-]{1,61}[A-Za-z0-9]";
const HANDLE = "[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?";
const BOUNDARY = "(?<![\\w@/.+-])";
const AGENT_PATTERN = new RegExp(`${BOUNDARY}@?(${LOGIN})/@(${HANDLE})(?![\\w-])`, "g");
const USER_PATTERN = new RegExp(`${BOUNDARY}@(${LOGIN})(?![\\w@/-])`, "g");

/** Finds `@login` and `owner/@handle` mentions in plain text that contains no code. */
export function findMentions(text: string): Mention[] {
  const found: Mention[] = [];
  const taken: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(AGENT_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    taken.push([start, end]);
    found.push({
      kind: "agent",
      owner: match[1].toLowerCase(),
      handle: match[2],
      start,
      end,
    });
  }
  for (const match of text.matchAll(USER_PATTERN)) {
    const start = match.index;
    if (taken.some(([from, to]) => start >= from && start < to)) continue;
    found.push({
      kind: "user",
      login: match[1].toLowerCase(),
      start,
      end: start + match[0].length,
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/** Removes fenced blocks and inline code spans so their contents never count as mentions. */
export function stripMarkdownCode(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const opening = FENCE.exec(line)?.[1];
    if (fence) {
      if (opening && opening[0] === fence[0] && opening.length >= fence.length) fence = null;
      continue;
    }
    if (opening) {
      fence = opening;
      continue;
    }
    kept.push(/^(?: {4}|\t)/.test(line) ? "" : line);
  }
  return kept.join("\n").replace(INLINE_CODE, " ");
}

export interface MentionSet {
  readonly users: string[];
  readonly agents: Array<{ readonly owner: string; readonly handle: string }>;
}

/** Unique mentions in a Markdown body, outside code, in order of first appearance. */
export function extractMentions(markdown: string): MentionSet {
  const users = new Set<string>();
  const agents = new Map<string, { owner: string; handle: string }>();
  for (const mention of findMentions(stripMarkdownCode(markdown))) {
    if (mention.kind === "user") users.add(mention.login);
    else agents.set(`${mention.owner}/${mention.handle}`, mention);
  }
  return {
    users: [...users],
    agents: [...agents.values()].map(({ owner, handle }) => ({ owner, handle })),
  };
}
