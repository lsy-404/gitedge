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
function escapeHtml(value: string): string {
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

export function renderMarkdown(
  source: string,
  baseUrl?: string,
  allowImages = false,
  repository?: MarkdownRepository
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
  if (repository) linkIssueReferences(fragment, repository);
  for (const block of fragment.querySelectorAll("pre code")) {
    const language = block.className.match(/language-([\w-]+)/)?.[1] ?? "";
    block.innerHTML = highlightedCode(block.textContent ?? "", language);
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}
