import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref, resolveComponent } from "vue";
import { fluentUi } from "../../apps/web/src/ui/fluent";

let dispose: (() => void) | undefined;
let originalMatchMedia: typeof window.matchMedia;
beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  })) as typeof window.matchMedia;
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  window.matchMedia = originalMatchMedia;
  document.body.innerHTML = "";
});

describe("Platform Kit controls", () => {
  it("renders a themed native submit button with disabled semantics", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(resolveComponent("FluentTheme"), { mode: "dark", accent: "#f6821f" }, () =>
          h(
            resolveComponent("FluentButton"),
            { type: "submit", tone: "primary", disabled: true },
            () => "Save"
          )
        ),
    });
    app.use(fluentUi);
    app.mount(host);
    dispose = () => app.unmount();

    expect(host.querySelector(".fluent-theme")?.getAttribute("data-fluent-theme")).toBe("dark");
    const button = host.querySelector("button");
    expect(button?.type).toBe("submit");
    expect(button?.disabled).toBe(true);
    expect(button?.classList.contains("fluent-button--primary")).toBe(true);
  });

  it("follows changes to the selected theme mode", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const mode = ref<"light" | "dark">("light");
    const app = createApp({
      render: () =>
        h(resolveComponent("FluentTheme"), { mode: mode.value }, () => h("main", "Content")),
    });
    app.use(fluentUi);
    app.mount(host);
    dispose = () => app.unmount();

    expect(host.querySelector(".fluent-theme")?.getAttribute("data-fluent-theme")).toBe("light");
    mode.value = "dark";
    await nextTick();
    expect(host.querySelector(".fluent-theme")?.getAttribute("data-fluent-theme")).toBe("dark");
  });
});
