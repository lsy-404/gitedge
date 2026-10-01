<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { sessionState } from "../lib/session";
const { t } = useI18n();
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h1>{{ t("account") }}</h1>
    </div>
    <div v-if="sessionState.user?.externalIdentity" class="box">
      <div class="box-header identity">
        <img
          v-if="sessionState.user.externalIdentity.avatarUrl"
          :src="sessionState.user.externalIdentity.avatarUrl"
          alt=""
        />
        <div>
          <div>GitHub</div>
          <a
            v-if="sessionState.user.externalIdentity.profileUrl"
            :href="sessionState.user.externalIdentity.profileUrl"
            target="_blank"
            rel="noreferrer"
            >@{{ sessionState.user.externalIdentity.login }}</a
          ><span v-else class="muted">@{{ sessionState.user.externalIdentity.login }}</span>
        </div>
      </div>
      <dl class="kv">
        <dt>{{ t("accessLevel") }}</dt>
        <dd>
          {{
            sessionState.user.externalIdentity.accessLevel === "read"
              ? t("readAccess")
              : t("identityAccess")
          }}
        </dd>
        <dt>{{ t("emails") }}</dt>
        <dd>
          <span v-if="sessionState.user.externalIdentity.emails?.length">{{
            sessionState.user.externalIdentity.emails.join(", ")
          }}</span
          ><span v-else class="muted">{{ t("noConnectedData") }}</span>
        </dd>
        <dt>{{ t("organizations") }}</dt>
        <dd>
          <span v-if="sessionState.user.externalIdentity.organizations?.length">{{
            sessionState.user.externalIdentity.organizations.map((item) => item.login).join(", ")
          }}</span
          ><span v-else class="muted">{{ t("noConnectedData") }}</span>
        </dd>
      </dl>
    </div>
    <div v-else class="box state">
      <p>{{ t("noGithubIdentity") }}</p>
      <RouterLink class="btn primary" to="/login">{{ t("signIn") }}</RouterLink>
    </div>
  </section>
</template>
