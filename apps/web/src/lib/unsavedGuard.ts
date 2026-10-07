import { onBeforeUnmount, onMounted, type Ref } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  type NavigationGuard,
  type RouteLocationNormalized,
} from "vue-router";
import { i18n } from "../i18n";

export interface UnsavedGuardOptions {
  /** Return true when a same-route navigation keeps the edited form mounted. */
  keepsForm?: (to: RouteLocationNormalized) => boolean;
}

/** Warns before route changes and tab close while `dirty` is true. */
export function useUnsavedGuard(
  dirty: Readonly<Ref<boolean>>,
  options: UnsavedGuardOptions = {}
): { confirmDiscard: () => boolean } {
  function confirmDiscard(): boolean {
    return !dirty.value || window.confirm(i18n.global.t("unsavedChangesConfirm"));
  }

  const leave: NavigationGuard = () => confirmDiscard();
  const update: NavigationGuard = (to) => options.keepsForm?.(to) === true || confirmDiscard();
  onBeforeRouteLeave(leave);
  onBeforeRouteUpdate(update);

  function warnOnUnload(event: BeforeUnloadEvent): void {
    if (dirty.value) event.preventDefault();
  }
  onMounted(() => window.addEventListener("beforeunload", warnOnUnload));
  onBeforeUnmount(() => window.removeEventListener("beforeunload", warnOnUnload));

  return { confirmDiscard };
}
