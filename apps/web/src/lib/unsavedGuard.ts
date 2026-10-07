import { onMounted, onUnmounted, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";

/** Asks before unsaved edits are discarded by route changes, tab close or an in-component cancel. */
export function useUnsavedGuard(dirty: Readonly<Ref<boolean>>) {
  const { t } = useI18n();
  const confirmDiscard = () => !dirty.value || window.confirm(t("unsavedChangesConfirm"));
  const warnBeforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty.value) event.preventDefault();
  };
  onBeforeRouteLeave(confirmDiscard);
  onBeforeRouteUpdate(confirmDiscard);
  onMounted(() => window.addEventListener("beforeunload", warnBeforeUnload));
  onUnmounted(() => window.removeEventListener("beforeunload", warnBeforeUnload));
  return { confirmDiscard };
}
