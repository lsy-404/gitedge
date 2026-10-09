import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import { findMentions } from "../../../../packages/contracts/src/mentions";

for (const [name, language] of Object.entries({
  javascript,
  typescript,
  json,
  css,
  xml,
  bash,
  python,
  sql,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}
const languages = new Map<string, string>(
  Object.entries({
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    css: "css",
    html: "xml",
    vue: "xml",
    svg: "xml",
    sh: "bash",
    bash: "bash",
    py: "python",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
  })
);
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function highlightedCode(source: string, filename: string = ""): string {
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const language = languages.get(extension) ?? (hljs.getLanguage(filename) ? filename : "");
  return language && source.length <= 500_000
    ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : escapeHtml(source);
}
function linkMentions(fragment: DocumentFragment): void {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node instanceof Text && !node.parentElement?.closest("a, code, pre")) texts.push(node);
  for (const node of texts) {
    const mentions = findMentions(node.data);
    if (mentions.length === 0) continue;
    const parts: Array<string | HTMLAnchorElement> = [];
    let cursor = 0;
    for (const mention of mentions) {
      parts.push(node.data.slice(cursor, mention.start));
      const link = document.createElement("a");
      link.href =
        mention.kind === "user"
          ? `/${encodeURIComponent(mention.login)}`
          : `/${encodeURIComponent(mention.owner)}/@${encodeURIComponent(mention.handle)}`;
      link.className = "mention";
      link.setAttribute("rel", "noreferrer noopener");
      link.textContent = node.data.slice(mention.start, mention.end);
      parts.push(link);
      cursor = mention.end;
    }
    parts.push(node.data.slice(cursor));
    node.replaceWith(...parts);
  }
}

export interface MarkdownRepository {
  owner: string;
  slug: string;
}
const ISSUE_REFERENCE =
  /(?<![\w/&.-])(?:(?<owner>[A-Za-z0-9][A-Za-z0-9-]*)\/(?<slug>[A-Za-z0-9_.-]+))?#(?<number>[1-9]\d{0,8})(?![\w-])/g;

/** Turns #n and same-repository owner/repo#n into links outside links and code. */
function linkIssueReferences(fragment: DocumentFragment, repository: MarkdownRepository): void {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node instanceof Text && !node.parentElement?.closest("a, pre, code")) targets.push(node);
  for (const text of targets) {
    const value = text.data;
    const pieces: Array<string | HTMLAnchorElement> = [];
    let cursor = 0;
    for (const match of value.matchAll(ISSUE_REFERENCE)) {
      const { owner, slug, number } = match.groups ?? {};
      if (
        owner &&
        slug &&
        (owner.toLowerCase() !== repository.owner.toLowerCase() ||
          slug.toLowerCase() !== repository.slug.toLowerCase())
      )
        continue;
      const anchor = document.createElement("a");
      anchor.href = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.slug)}/issues/${number}`;
      anchor.textContent = match[0];
      anchor.setAttribute("rel", "noreferrer noopener");
      pieces.push(value.slice(cursor, match.index), anchor);
      cursor = match.index + match[0].length;
    }
    if (!pieces.length) continue;
    pieces.push(value.slice(cursor));
    text.replaceWith(...pieces);
  }
}

export interface MarkdownLinks {
  mentions?: boolean;
  /** Links #n references to issues of this repository. */
  repository?: MarkdownRepository;
}

export function renderMarkdown(
  source: string,
  baseUrl?: string,
  allowImages = false,
  links: MarkdownLinks = {}
): string {
  const renderer = new Renderer();
  if (!allowImages) {
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.image = ({ href, text }) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  }
  const html = marked.parse(source, {
    async: false,
    gfm: true,
    breaks: false,
    renderer,
  });
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [
      "form",
      "button",
      "textarea",
      "select",
      "style",
      "iframe",
      "video",
      "audio",
      "source",
      "track",
      "picture",
    ],
    FORBID_ATTR: ["style", "srcset"],
  });
  for (const element of fragment.querySelectorAll("[class]")) {
    if (!(element.matches("pre > code") && /^language-[\w-]+$/.test(element.className)))
      element.removeAttribute("class");
  }
  for (const input of fragment.querySelectorAll("input")) {
    if (input.type !== "checkbox") input.remove();
    else {
      input.disabled = true;
      input.closest("li")?.classList.add("task-list-item");
    }
  }
  for (const link of fragment.querySelectorAll("a:not([href])"))
    link.replaceWith(...link.childNodes);
  for (const element of fragment.querySelectorAll("a[href], img[src]")) {
    const attribute = element.tagName === "A" ? "href" : "src";
    const value = element.getAttribute(attribute) ?? "";
    if (baseUrl && value && !value.startsWith("#")) {
      try {
        const base = new URL(baseUrl, window.location.origin);
        const resolved = new URL(value, base);
        if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith("//"))
          resolved.search ||= base.search;
        element.setAttribute(attribute, resolved.href);
      } catch {
        element.removeAttribute(attribute);
      }
    }
    if (element.tagName === "A") {
      element.setAttribute("rel", "noreferrer noopener");
      const href = element.getAttribute("href") ?? "";
      if (/^https?:/i.test(href)) {
        try {
          if (new URL(href).origin !== window.location.origin)
            element.setAttribute("target", "_blank");
        } catch {
          element.removeAttribute("href");
        }
      }
    } else {
      element.setAttribute("loading", "lazy");
      element.setAttribute("referrerpolicy", "no-referrer");
    }
  }
  if (links.mentions) linkMentions(fragment);
  if (links.repository) linkIssueReferences(fragment, links.repository);
  for (const block of fragment.querySelectorAll("pre code")) {
    const language = block.className.match(/language-([\w-]+)/)?.[1] ?? "";
    block.innerHTML = highlightedCode(block.textContent ?? "", language);
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}
