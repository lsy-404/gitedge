<script setup lang="ts">
import "../styles/social.css";
defineProps<{ topics: readonly string[] }>();
</script>
<template>
  <ul v-if="topics.length" class="topic-chips">
    <li v-for="topic in topics" :key="topic">
      <RouterLink class="topic-chip" :to="{ path: '/explore', query: { topic } }">{{
        topic
      }}</RouterLink>
    </li>
  </ul>
</template>
