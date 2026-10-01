<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, type Organization, type OrganizationMember } from "../lib/api";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
const route = useRoute();
const { t } = useI18n();
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
      <RouterLink class="btn" to="/organizations">{{ t("organizations") }}</RouterLink>
    </div>
    <StatusState :loading="loading" :error="error" @retry="load" />
    <div v-if="!loading && !error" class="box">
      <div class="box-header">
        {{ t("members") }} <span class="count">{{ members.length }}</span>
      </div>
      <div v-for="member in members" :key="member.identifier" class="box-row">
        <div class="grow row-title">{{ member.identifier }}</div>
        <span class="pill">{{ member.role === "owner" ? t("ownerRole") : t("memberRole") }}</span>
      </div>
      <div v-if="!members.length" class="state">{{ t("empty") }}</div>
    </div>
    <form
      v-if="!loading && !error && organization?.role === 'owner'"
      class="box box-form form-stack"
      style="margin-top: 16px"
      @submit.prevent="addMember"
    >
      <h2>{{ t("addMember") }}</h2>
      <label class="field"
        >{{ t("memberIdentifier") }}<input v-model="form.identifier" required
      /></label>
      <label class="field"
        >{{ t("role")
        }}<select v-model="form.role">
          <option value="member">{{ t("memberRole") }}</option>
          <option value="owner">{{ t("ownerRole") }}</option>
        </select></label
      >
      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <div class="form-actions">
        <button class="btn primary" :disabled="saving">
          {{ saving ? t("loading") : t("addMember") }}
        </button>
      </div>
    </form>
  </section>
</template>
