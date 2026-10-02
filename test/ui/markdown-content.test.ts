import { afterEach, describe, expect, it } from "vitest";
import { createApp, h } from "vue";
import MarkdownContent from "../../apps/web/src/components/MarkdownContent.vue";

const roots: HTMLElement[] = [];

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  createApp({ render: () => h(MarkdownContent, { source }) }).mount(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) root.remove();
});

describe("MarkdownContent", () => {
  it("renders headings, lists, tables and code", () => {
    const root = render("# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`inline`");
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelectorAll("td")).toHaveLength(2);
    expect(root.querySelector("code")?.textContent).toBe("inline");
  });

  it("escapes raw HTML and refuses scripts, unsafe links and remote images", () => {
    const root = render(
      [
        "<script>window.hacked = true</script>",
        '<img src="https://evil.example/a.png" onerror="window.hacked = true">',
        "[bad](javascript:alert(1))",
        "![tracker](https://evil.example/pixel.png)",
        "[good](https://example.com/docs)",
        "[local](/acme/project/issues/3)",
      ].join("\n\n")
    );
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(Reflect.get(window, "hacked")).toBeUndefined();
    const hrefs = Array.from(root.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    // A disabled image degrades to a plain link that is only followed on click.
    expect(hrefs).toEqual([
      "https://evil.example/pixel.png",
      "https://example.com/docs",
      "/acme/project/issues/3",
    ]);
    const external = root.querySelector("a[href^='https://example.com']");
    expect(external?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(root.querySelector("a[href^='/acme']")?.getAttribute("target")).toBeNull();
  });
});
