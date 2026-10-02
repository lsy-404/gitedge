import { describe, expect, it } from "vitest";
import { eventActiveId, eventChecked, eventValue, oneOf } from "../../apps/web/src/ui/formEvents";

/** Dispatches an event from a custom element that carries the given properties, like a Fluent host. */
function emitFrom(properties: Record<string, unknown>, type = "input"): Event {
  const host = document.createElement("fluent-control");
  Object.assign(host, properties);
  document.body.append(host);
  let received: Event | undefined;
  host.addEventListener(type, (event) => (received = event));
  host.dispatchEvent(new Event(type, { bubbles: true }));
  host.remove();
  if (!received) throw new Error("Event was not delivered");
  return received;
}

describe("form event helpers", () => {
  it("reads the value from a custom element target", () => {
    expect(eventValue(emitFrom({ value: "main" }))).toBe("main");
    expect(eventValue(emitFrom({ value: "" }))).toBe("");
  });

  it("falls back to an empty value when the target has no string value", () => {
    expect(eventValue(emitFrom({ value: 3 }))).toBe("");
    expect(eventValue(emitFrom({}))).toBe("");
    expect(eventValue(new Event("input"))).toBe("");
  });

  it("reads checked state only when it is exactly true", () => {
    expect(eventChecked(emitFrom({ checked: true }, "change"))).toBe(true);
    expect(eventChecked(emitFrom({ checked: false }, "change"))).toBe(false);
    expect(eventChecked(emitFrom({ checked: "yes" }, "change"))).toBe(false);
    expect(eventChecked(emitFrom({}, "change"))).toBe(false);
  });

  it("reads the active tab id", () => {
    expect(eventActiveId(emitFrom({ activeid: "tab-issues" }, "change"))).toBe("tab-issues");
    expect(eventActiveId(emitFrom({}, "change"))).toBe("");
  });

  it("narrows free-form values back to a known literal", () => {
    const states = ["read", "write"] as const;
    expect(oneOf(states, "write", "read")).toBe("write");
    expect(oneOf(states, "admin", "read")).toBe("read");
  });
});
