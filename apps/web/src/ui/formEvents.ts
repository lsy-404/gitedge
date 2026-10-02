/**
 * Fluent form controls are custom elements: they emit native `input`/`change` events whose target
 * is the host element, carrying `value` or `checked` as properties. These helpers read them
 * without assuming the target is an HTMLInputElement.
 */

export function eventValue(event: Event): string {
  const target = event.target;
  return target !== null && "value" in target && typeof target.value === "string"
    ? target.value
    : "";
}

/** The `activeid` a Fluent tablist reports after the selected tab changes. */
export function eventActiveId(event: Event): string {
  const target = event.target;
  return target !== null && "activeid" in target && typeof target.activeid === "string"
    ? target.activeid
    : "";
}

export function eventChecked(event: Event): boolean {
  const target = event.target;
  return target !== null && "checked" in target && target.checked === true;
}

/** Narrows a free-form control value back to a known literal, without casting. */
export function oneOf<T extends string>(allowed: readonly T[], value: string, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}
