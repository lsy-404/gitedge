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
const languages: Record<string, string> = {
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
};
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function highlightedCode(source: string, filename: string = ""): string {
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const language = languages[extension] ?? (hljs.getLanguage(filename) ? filename : "");
  return language && source.length <= 500_000
    ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : escapeHtml(source);
}
export function renderMarkdown(source: string, baseUrl?: string, allowImages = false): string {
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
    FORBID_TAGS: ["form", "button", "textarea", "select", "style", "iframe"],
    FORBID_ATTR: ["style", "srcset"],
  });
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
  for (const block of fragment.querySelectorAll("pre code")) {
    const language = block.className.match(/language-([\w-]+)/)?.[1] ?? "";
    block.innerHTML = highlightedCode(block.textContent ?? "", language);
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}
