const FOCUSABLE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

function isVisibleFocusTarget(
  target: EventTarget | null,
  keyboardNavigation: boolean
): target is HTMLElement {
  if (!(target instanceof HTMLElement) || !target.matches(FOCUSABLE_SELECTOR)) return false;
  if (!target.matches(":focus-visible") && !keyboardNavigation) return false;
  const style = getComputedStyle(target);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = target.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && target.getClientRects().length > 0;
}

export function installFluentMotion(): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const indicator = document.createElement("div");
  indicator.className = "fluent-focus-indicator";
  indicator.setAttribute("aria-hidden", "true");
  document.body.append(indicator);

  let activeTarget: HTMLElement | null = null;
  let frame = 0;
  let keyboardNavigation = false;
  let resizeObserver: ResizeObserver | undefined;

  function hide() {
    activeTarget?.classList.remove("fluent-focus-target--tracked");
    activeTarget = null;
    resizeObserver?.disconnect();
    indicator.classList.remove("fluent-focus-indicator--visible");
  }

  function update() {
    frame = 0;
    if (
      reducedMotion.matches ||
      !activeTarget?.isConnected ||
      document.activeElement !== activeTarget ||
      !isVisibleFocusTarget(activeTarget, keyboardNavigation)
    ) {
      hide();
      return;
    }

    const rect = activeTarget.getBoundingClientRect();
    const radius = Number.parseFloat(getComputedStyle(activeTarget).borderTopLeftRadius) || 0;
    activeTarget.classList.add("fluent-focus-target--tracked");
    indicator.style.left = `${rect.left - 4}px`;
    indicator.style.top = `${rect.top - 4}px`;
    indicator.style.width = `${rect.width + 8}px`;
    indicator.style.height = `${rect.height + 8}px`;
    indicator.style.borderRadius = `${radius + 4}px`;
    indicator.classList.add("fluent-focus-indicator--visible");
  }

  function scheduleUpdate() {
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  function trackFocusTarget(target: EventTarget | null) {
    if (!isVisibleFocusTarget(target, keyboardNavigation) || reducedMotion.matches) {
      hide();
      return;
    }
    activeTarget?.classList.remove("fluent-focus-target--tracked");
    activeTarget = target;
    resizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(target);
    }
    update();
  }

  function onFocusIn(event: FocusEvent) {
    trackFocusTarget(event.target);
  }

  function onFocusOut() {
    queueMicrotask(() => {
      if (document.activeElement !== activeTarget) scheduleUpdate();
    });
  }

  function onMotionPreferenceChange() {
    if (reducedMotion.matches) hide();
    else if (isVisibleFocusTarget(document.activeElement, keyboardNavigation))
      trackFocusTarget(document.activeElement);
  }

  function onKeyDown() {
    keyboardNavigation = true;
  }

  function onPointerDown() {
    keyboardNavigation = false;
    hide();
  }

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);
  reducedMotion.addEventListener("change", onMotionPreferenceChange);

  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    reducedMotion.removeEventListener("change", onMotionPreferenceChange);
    if (frame) window.cancelAnimationFrame(frame);
    activeTarget?.classList.remove("fluent-focus-target--tracked");
    resizeObserver?.disconnect();
    indicator.remove();
  };
}
