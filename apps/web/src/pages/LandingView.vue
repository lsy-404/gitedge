<script setup lang="ts">
import { useI18n } from "vue-i18n";
import AppIcon, { type IconName } from "../components/AppIcon.vue";
import "../styles/landing.css";

const { t } = useI18n();

const capabilities: { icon: IconName; title: string; text: string }[] = [
  { icon: "code", title: "landingCap_git_title", text: "landingCap_git_text" },
  { icon: "gitMerge", title: "landingCap_review_title", text: "landingCap_review_text" },
  { icon: "agent", title: "landingCap_agents_title", text: "landingCap_agents_text" },
  { icon: "terminal", title: "landingCap_actions_title", text: "landingCap_actions_text" },
  { icon: "github", title: "landingCap_sync_title", text: "landingCap_sync_text" },
  { icon: "link", title: "landingCap_mcp_title", text: "landingCap_mcp_text" },
  { icon: "cloud", title: "landingCap_cache_title", text: "landingCap_cache_text" },
];

const path: { label: string; primitive: string }[] = [
  { label: "landingService_gateway", primitive: "Workers" },
  { label: "landingService_auth", primitive: "D1" },
  { label: "landingService_forge", primitive: "D1 + R2" },
  { label: "landingService_git", primitive: "Artifacts" },
  { label: "landingService_limits", primitive: "Durable Objects" },
  { label: "landingService_actions", primitive: "Containers" },
];
</script>
<template>
  <div class="landing">
    <section class="landing-hero" aria-labelledby="landing-title">
      <div class="landing-hero-copy">
        <h1 id="landing-title">{{ t("landingHeadline") }}</h1>
        <p class="landing-lede">{{ t("landingLede") }}</p>
        <div class="landing-actions">
          <RouterLink class="btn btn-primary" to="/register">{{ t("landingCtaStart") }}</RouterLink>
          <RouterLink class="btn" to="/login">{{ t("signIn") }}</RouterLink>
        </div>
        <p class="landing-links">
          <RouterLink to="/explore"
            ><AppIcon name="compass" :size="16" />{{ t("landingCtaExplore") }}</RouterLink
          >
          <RouterLink to="/docs/api"
            ><AppIcon name="book" :size="16" />{{ t("landingCtaDocs") }}</RouterLink
          >
          <a href="https://github.com/lsy-404/gitedge" target="_blank" rel="noreferrer"
            ><AppIcon name="github" :size="16" />{{ t("ghSource") }}</a
          >
        </p>
      </div>
      <figure class="landing-path">
        <figcaption>{{ t("landingPathTitle") }}</figcaption>
        <code class="landing-command">git push origin main</code>
        <ol>
          <li v-for="item in path" :key="item.label">
            <span class="landing-service">{{ t(item.label) }}</span>
            <span class="landing-primitive">{{ item.primitive }}</span>
          </li>
        </ol>
      </figure>
    </section>
    <section class="landing-capabilities" aria-labelledby="landing-capabilities-title">
      <h2 id="landing-capabilities-title">{{ t("landingCapabilitiesTitle") }}</h2>
      <ul>
        <li v-for="item in capabilities" :key="item.title">
          <AppIcon :name="item.icon" :size="20" />
          <h3>{{ t(item.title) }}</h3>
          <p>{{ t(item.text) }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>
