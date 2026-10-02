import { describe, expect, it } from "vitest";
import { renderMarkdown, highlightedCode } from "../../apps/web/src/lib/markdown";

describe("repository Markdown", () => {
  it("renders headings, tables, tasks and code as sanitized content", () => {
    const html = renderMarkdown(
      "# Readme\n\n| File | Purpose |\n| --- | --- |\n| a.ts | Worker |\n\n- [x] Shipped\n\n```js\nconst x = 1;\n```"
    );
    expect(html).toContain("<h1>Readme</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("hljs-keyword");
  });
  it("removes executable markup and unsafe URLs", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">open</a><form><input name="token"></form>',
      undefined,
      true
    );
    expect(html).not.toMatch(/script|onerror|javascript:|<form|name="token"/);
    expect(html).toContain("open");
  });
  it("resolves repository links and preserves the selected ref", () => {
    const html = renderMarkdown(
      "[Guide](docs/guide.md)",
      "https://git.example/owner/repo/blob/?ref=feature"
    );
    expect(html).toContain('href="https://git.example/owner/repo/blob/docs/guide.md?ref=feature"');
    expect(highlightedCode("<script>", "unknown")).toBe("&lt;script&gt;");
  });
});
