<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { ExploreRepository } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import TopicChips from "./TopicChips.vue";
import "../styles/social.css";

defineProps<{ items: readonly ExploreRepository[] }>();
const { t, d } = useI18n();
const repositoryPath = (item: Pick<ExploreRepository, "owner" | "name">) =>
  `/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}`;
</script>
<template>
  <section class="box">
    <article v-for="item in items" :key="item.id" class="box-row explore-repository">
      <div class="explore-repository-title">
        <AppIcon name="repo" />
        <RouterLink :to="repositoryPath(item)">{{ item.owner }}/{{ item.name }}</RouterLink>
      </div>
      <p v-if="item.description">{{ item.description }}</p>
      <TopicChips :topics="item.topics" />
      <div class="explore-repository-meta">
        <span
          ><AppIcon name="star" :size="14" /> {{ t("starCount", { count: item.starCount }) }}</span
        >
        <span v-if="item.forkOf"
          ><AppIcon name="fork" :size="14" /> {{ t("forkedFrom") }}
          <RouterLink :to="repositoryPath(item.forkOf)"
            >{{ item.forkOf.owner }}/{{ item.forkOf.name }}</RouterLink
          ></span
        >
        <span>{{ t("exploreUpdated", { date: d(item.updatedAt, "long") }) }}</span>
      </div>
    </article>
  </section>
</template>
