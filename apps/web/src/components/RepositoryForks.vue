<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { Organization, Repository } from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import { sessionState } from "../lib/session";
import AppIcon from "./AppIcon.vue";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import StatusState from "./StatusState.vue";
import TextField from "./TextField.vue";
import TopicChips from "./TopicChips.vue";
import "../styles/social.css";

const props = defineProps<{ repository: Repository }>();
const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const forks = ref<Repository[]>([]);
const truncated = ref(false);
const organizations = ref<Organization[]>([]);
const loading = ref(true);
const loadError = ref("");
const creating = ref(false);
const createError = ref("");
const owner = ref(sessionState.user?.identifier ?? "");
const name = ref(props.repository.slug);
const signedIn = computed(() => sessionState.user !== null);
// A private repository may only be forked into the caller's account or its own organization.
const owners = computed(() => [
  ...(sessionState.user ? [sessionState.user.identifier] : []),
  ...organizations.value
    .filter(
      (item) =>
        item.role === "owner" &&
        (props.repository.visibility === "public" || item.slug === props.repository.owner)
    )
    .map((item) => item.slug),
]);
const loginTarget = computed(() => ({ path: "/login", query: { redirect: route.fullPath } }));

const errorKeys: Readonly<Record<string, string>> = {
  conflict: "forkErrorNameTaken",
  quota_exceeded: "forkErrorQuota",
  forbidden: "forkErrorOwner",
  fork_owner_not_allowed: "forkErrorPrivateOwner",
};
const path = (item: Pick<Repository, "owner" | "name">) =>
  `/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}`;

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const page = await api.forks(props.repository.id);
    forks.value = page.items;
    truncated.value = page.truncated;
  } catch {
    loadError.value = t("forkLoadError");
  } finally {
    loading.value = false;
  }
}
async function loadOrganizations(): Promise<void> {
  if (!signedIn.value) return;
  try {
    organizations.value = await api.organizations();
  } catch {
    organizations.value = [];
  }
}
async function create(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  createError.value = "";
  try {
    const created = await api.forkRepository(props.repository.id, {
      owner: owner.value,
      name: name.value.trim() || undefined,
    });
    await router.push(path(created));
  } catch (cause) {
    createError.value =
      cause instanceof ApiError && cause.code && errorKeys[cause.code]
        ? t(errorKeys[cause.code])
        : errorMessage(cause, t, {}, "forkError");
  } finally {
    creating.value = false;
  }
}
onMounted(() => {
  void load();
  void loadOrganizations();
});
</script>

<template>
  <section class="box">
    <header class="box-header">
      <AppIcon name="fork" />
      <h2>{{ t("forksTitle") }}</h2>
    </header>
    <div class="box-row">
      <p class="muted">{{ t("forksIntro") }}</p>
      <p v-if="repository.visibility === 'private'" class="muted">{{ t("forkPrivateNote") }}</p>
      <form v-if="signedIn" class="fork-form" @submit.prevent="create">
        <SelectField v-model="owner" :label="t('forkOwner')">
          <option v-for="slug in owners" :key="slug" :value="slug">{{ slug }}</option>
        </SelectField>
        <TextField v-model="name">{{ t("forkName") }}</TextField>
        <button class="btn btn-primary" type="submit" :disabled="creating">
          <AppIcon name="fork" />{{ creating ? t("forkCreating") : t("forkCreate") }}
        </button>
      </form>
      <RouterLink v-else class="btn" :to="loginTarget">{{ t("forkSignIn") }}</RouterLink>
      <NoticeBar v-if="createError" intent="error">{{ createError }}</NoticeBar>
    </div>
    <StatusState
      :loading="loading"
      :error="loadError"
      :empty="!loading && !loadError && !forks.length"
      @retry="load"
      ><template #empty>
        <p>{{ t("forkEmpty") }}</p>
      </template></StatusState
    >
    <NoticeBar v-if="truncated" intent="warning">{{
      t("forkTruncated", { count: forks.length })
    }}</NoticeBar>
    <article v-for="fork in forks" :key="fork.id" class="box-row explore-repository">
      <div class="explore-repository-title">
        <AppIcon name="repo" /><RouterLink :to="path(fork)"
          >{{ fork.owner }}/{{ fork.name }}</RouterLink
        >
      </div>
      <p v-if="fork.description">{{ fork.description }}</p>
      <TopicChips :topics="fork.topics" />
      <div class="explore-repository-meta">
        <span
          ><AppIcon name="star" :size="14" /> {{ t("starCount", { count: fork.starCount }) }}</span
        >
        <span>{{ t("exploreUpdated", { date: d(fork.updatedAt, "long") }) }}</span>
      </div>
    </article>
  </section>
</template>
