<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, type Organization, type OrganizationMember } from "../lib/api";
import AppLink from "../components/AppLink.vue";
import NoticeBar from "../components/NoticeBar.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { oneOf } from "../ui/formEvents";
import StatusState from "../components/StatusState.vue";
import TextField from "../components/TextField.vue";
const route = useRoute();
const { t } = useI18n();
const roles = ["member", "owner"] as const;
const slug = String(route.params.slug);
const organization = ref<Organization | null>(null);
const members = ref<OrganizationMember[]>([]);
const loading = ref(true);
const error = ref("");
const formError = ref("");
const saving = ref(false);
const form = ref({ identifier: "", role: "member" as "owner" | "member" });
async function load() {
  loading.value = true;
  try {
    [organization.value, members.value] = await Promise.all([
      api.organization(slug),
      api.organizationMembers(slug),
    ]);
  } catch {
    error.value = t("apiError");
  } finally {
    loading.value = false;
  }
}
async function addMember() {
  saving.value = true;
  formError.value = "";
  try {
    await api.addOrganizationMember(slug, form.value);
    form.value = { identifier: "", role: "member" };
    await load();
  } catch {
    formError.value = t("apiError");
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="page">
    <div class="page-head">
      <div>
        <h1>{{ organization?.displayName || slug }}</h1>
        <p>{{ organization?.description || t("noDescription") }}</p>
      </div>
      <AppLink to="/organizations" button="secondary">{{ t("organizations") }}</AppLink>
    </div>
    <StatusState :loading="loading" :error="error" @retry="load" />
    <div v-if="!loading && !error" class="box">
      <div class="box-header">
        {{ t("members") }} <fluent-counter-badge :count="members.length" show-zero />
      </div>
      <div v-for="member in members" :key="member.identifier" class="box-row">
        <div class="grow row-title">{{ member.identifier }}</div>
        <StatusBadge :tone="member.role === 'owner' ? 'brand' : 'neutral'">{{
          member.role === "owner" ? t("ownerRole") : t("memberRole")
        }}</StatusBadge>
      </div>
      <div v-if="!members.length" class="state">{{ t("empty") }}</div>
    </div>
    <form
      v-if="!loading && !error && organization?.role === 'owner'"
      class="box box-form form-stack spaced"
      @submit.prevent="addMember"
    >
      <h2>{{ t("addMember") }}</h2>
      <TextField v-model="form.identifier" required>{{ t("memberIdentifier") }}</TextField>
      <SelectField
        :model-value="form.role"
        :label="t('role')"
        @update:model-value="form.role = oneOf(roles, $event, 'member')"
      >
        <fluent-option value="member">{{ t("memberRole") }}</fluent-option>
        <fluent-option value="owner">{{ t("ownerRole") }}</fluent-option>
      </SelectField>
      <NoticeBar v-if="formError" intent="error">{{ formError }}</NoticeBar>
      <div class="form-actions">
        <fluent-button type="submit" appearance="primary" :disabled="saving">
          {{ saving ? t("loading") : t("addMember") }}
        </fluent-button>
      </div>
    </form>
  </section>
</template>
