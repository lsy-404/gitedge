<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { WatchLevels } from "../../../../packages/contracts/src/social";
import type { Repository, RepositorySocial, WatchLevel } from "../lib/api";
import { api } from "../lib/api";
import { sessionState } from "../lib/session";
import { eventValue, oneOf } from "../ui/formEvents";
import AppIcon from "./AppIcon.vue";
import "../styles/social.css";

const props = defineProps<{ repository: Repository }>();
const { t } = useI18n();
const route = useRoute();
const signedIn = computed(() => sessionState.user !== null);
const starCount = ref(props.repository.starCount);
const forkCount = ref(props.repository.forkCount);
const starred = ref(false);
const watchLevel = ref<WatchLevel>("participating");
const busy = ref(false);
const error = ref("");
const base = computed(() => `/${props.repository.owner}/${props.repository.name}`);
const loginTarget = computed(() => ({ path: "/login", query: { redirect: route.fullPath } }));
let version = 0;

function apply(state: RepositorySocial): void {
  starCount.value = state.starCount;
  forkCount.value = state.forkCount;
  starred.value = state.starred;
  watchLevel.value = state.watchLevel;
}
async function load(): Promise<void> {
  const current = ++version;
  starCount.value = props.repository.starCount;
  forkCount.value = props.repository.forkCount;
  starred.value = false;
  watchLevel.value = "participating";
  error.value = "";
  if (!signedIn.value) return;
  try {
    const state = await api.repositorySocial(props.repository.id);
    if (current === version) apply(state);
  } catch {
    // The counters from the repository response stay visible; the toggles retry on use.
  }
}
async function toggleStar(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    apply(await api.setStar(props.repository.id, !starred.value));
  } catch {
    error.value = t("starError");
  } finally {
    busy.value = false;
  }
}
async function changeWatch(level: WatchLevel): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    apply(await api.setWatchLevel(props.repository.id, level));
  } catch {
    watchLevel.value =
      (await api.repositorySocial(props.repository.id).catch(() => null))?.watchLevel ??
      watchLevel.value;
    error.value = t("watchError");
  } finally {
    busy.value = false;
  }
}
watch(() => [props.repository.id, signedIn.value], load, { immediate: true });
</script>

<template>
  <div class="social-bar">
    <template v-if="signedIn">
      <button
        type="button"
        class="btn btn-sm"
        :aria-pressed="starred"
        :disabled="busy"
        @click="toggleStar"
      >
        <AppIcon name="star" />{{ t(starred ? "starActionDone" : "starAction") }}
        <span class="social-count">{{ starCount }}</span>
      </button>
      <select
        class="social-watch"
        :aria-label="t('watchLabel')"
        :title="t('watchHint')"
        :value="watchLevel"
        :disabled="busy"
        @change="changeWatch(oneOf(WatchLevels, eventValue($event), 'participating'))"
      >
        <option value="participating">{{ t("watchLabel") }}: {{ t("watchParticipating") }}</option>
        <option value="all">{{ t("watchLabel") }}: {{ t("watchAll") }}</option>
        <option value="ignore">{{ t("watchLabel") }}: {{ t("watchIgnore") }}</option>
      </select>
    </template>
    <RouterLink v-else class="btn btn-sm" :to="loginTarget" :title="t('starSignIn')">
      <AppIcon name="star" />{{ t("starAction") }}
      <span class="social-count">{{ starCount }}</span>
    </RouterLink>
    <RouterLink class="btn btn-sm" :to="`${base}/forks`">
      <AppIcon name="fork" />{{ t("forkAction") }}
      <span class="social-count">{{ forkCount }}</span>
    </RouterLink>
    <span v-if="error" class="social-error" role="alert">{{ error }}</span>
  </div>
</template>
