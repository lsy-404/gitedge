import { afterEach, describe, expect, it, vi } from "vitest";
import { installFluentMotion } from "../../apps/web/src/ui/fluentMotion";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mockFocusLayout(element: HTMLElement, left: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: 20,
    left,
    top: 20,
    right: left + 80,
    bottom: 52,
    width: 80,
    height: 32,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(element, "getClientRects").mockReturnValue([element.getBoundingClientRect()]);
}

describe("Fluent motion focus indicator", () => {
  it("follows keyboard-visible focus and clears when focus leaves", async () => {
    cleanups.push(installFluentMotion());
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    mockFocusLayout(first, 10);
    mockFocusLayout(second, 120);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    first.focus();

    const indicator = document.querySelector<HTMLElement>(".fluent-focus-indicator");
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(true);
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.style.left).toBe("6px");
    expect(document.querySelectorAll("[tabindex]")).toHaveLength(0);

    second.focus();
    expect(indicator?.style.left).toBe("116px");
    second.blur();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(false);
  });

  it("keeps the native focus state and suppresses the moving ring for reduced motion", () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      dispatchEvent: () => true,
    } as MediaQueryList;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media)
    );
    cleanups.push(installFluentMotion());
    const button = document.createElement("button");
    document.body.append(button);
    mockFocusLayout(button, 10);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();

    const indicator = document.querySelector<HTMLElement>(".fluent-focus-indicator");
    expect(document.activeElement).toBe(button);
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(false);

    Object.defineProperty(media, "matches", { value: false, configurable: true });
    listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(true);
  });

  it("keeps native focus rings inside top-layer dialogs and popovers", () => {
    cleanups.push(installFluentMotion());
    const dialog = document.createElement("dialog");
    dialog.open = true;
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    mockFocusLayout(button, 10);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();

    const indicator = document.querySelector<HTMLElement>(".fluent-focus-indicator");
    expect(button.classList.contains("fluent-focus-target--tracked")).toBe(false);
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(false);

    const popover = document.createElement("div");
    popover.setAttribute("popover", "manual");
    const popoverButton = document.createElement("button");
    popover.append(popoverButton);
    document.body.append(popover);
    mockFocusLayout(popoverButton, 120);
    popoverButton.focus();
    expect(popoverButton.classList.contains("fluent-focus-target--tracked")).toBe(false);
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(false);
  });

  it("hides while the page is inactive and restores the current keyboard focus", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    cleanups.push(installFluentMotion());
    const button = document.createElement("button");
    document.body.append(button);
    mockFocusLayout(button, 10);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();
    const indicator = document.querySelector<HTMLElement>(".fluent-focus-indicator");
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(true);

    window.dispatchEvent(new Event("blur"));
    expect(button.classList.contains("fluent-focus-target--tracked")).toBe(false);
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(false);
    window.dispatchEvent(new Event("focus"));
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(true);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(indicator?.classList.contains("fluent-focus-indicator--visible")).toBe(true);
  });

  it("refreshes its position when a focused animated menu finishes entering", async () => {
    cleanups.push(installFluentMotion());
    const menu = document.createElement("div");
    menu.className = "dropdown-panel";
    const button = document.createElement("button");
    menu.append(button);
    document.body.append(menu);
    let left = 10;
    vi.spyOn(button, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: left,
          y: 20,
          left,
          top: 20,
          right: left + 80,
          bottom: 52,
          width: 80,
          height: 32,
          toJSON: () => ({}),
        }) as DOMRect
    );
    vi.spyOn(button, "getClientRects").mockReturnValue([button.getBoundingClientRect()]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();
    const indicator = document.querySelector<HTMLElement>(".fluent-focus-indicator");
    expect(indicator?.style.left).toBe("6px");

    left = 80;
    menu.dispatchEvent(new Event("animationend", { bubbles: true }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(indicator?.style.left).toBe("76px");
  });

  it("removes listeners and pending focus cleanup when disposed", async () => {
    const stop = installFluentMotion();
    const button = document.createElement("button");
    document.body.append(button);
    mockFocusLayout(button, 10);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.focus();
    expect(button.classList.contains("fluent-focus-target--tracked")).toBe(true);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    button.blur();
    stop();
    await Promise.resolve();

    expect(document.querySelector(".fluent-focus-indicator")).toBeNull();
    expect(button.classList.contains("fluent-focus-target--tracked")).toBe(false);
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
