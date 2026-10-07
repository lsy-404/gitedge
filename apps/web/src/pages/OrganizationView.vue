<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, type Organization, type OrganizationMember, errorMessage } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";
import ConfirmButton from "../components/ConfirmButton.vue";
import NoticeBar from "../components/NoticeBar.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { oneOf } from "../ui/formEvents";
import StatusState from "../components/StatusState.vue";
import TextField from "../components/TextField.vue";
import "../styles/workspace.css";
const route = useRoute();
const { t } = useI18n();
const roles = ["member", "owner"] as const;
const slug = computed(() => String(route.params.slug));
const organization = ref<Organization | null>(null);
const members = ref<OrganizationMember[]>([]);
const loading = ref(true);
const error = ref("");
const formError = ref("");
const saving = ref(false);
const removingIdentifier = ref("");
const memberNotice = ref("");
const revocationIncomplete = ref(false);
let loadVersion = 0;
const form = ref<{ identifier: string; role: "owner" | "member" }>({
  identifier: "",
  role: "member",
});
async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const [org, list] = await Promise.all([
      api.organization(slug.value),
      api.organizationMembers(slug.value),
    ]);
    if (version === loadVersion) {
      organization.value = org;
      members.value = list;
    }
  } catch (cause) {
    if (version === loadVersion) error.value = errorMessage(cause, t);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
async function addMember() {
  const target = slug.value;
  saving.value = true;
  formError.value = "";
  try {
    await api.addOrganizationMember(target, form.value);
    form.value = { identifier: "", role: "member" };
    await load();
  } catch (cause) {
    formError.value = errorMessage(cause, t);
  } finally {
    saving.value = false;
  }
}
async function removeMember(member: OrganizationMember) {
  const target = slug.value;
  removingIdentifier.value = member.identifier;
  formError.value = "";
  memberNotice.value = "";
  revocationIncomplete.value = false;
  try {
    revocationIncomplete.value = await api.removeOrganizationMember(target, member.identifier);
    memberNotice.value = t("organizationMemberRemoved");
    await load();
  } catch (cause) {
    formError.value = errorMessage(cause, t, {}, "organizationMemberRemoveError");
  } finally {
    removingIdentifier.value = "";
  }
}
watch(slug, load, { immediate: true });
</script>
<template>
  <section class="workspace-page organization-page">
    <header class="organization-banner">
      <span class="organization-avatar">{{
        (organization?.displayName || slug).slice(0, 1).toUpperCase()
      }}</span>
      <div class="organization-banner-main">
        <p class="workspace-eyebrow">{{ t("organization") }}</p>
        <h1>{{ organization?.displayName || slug }}</h1>
        <p>{{ organization?.description || t("noDescription") }}</p>
      </div>
      <StatusBadge
        v-if="organization?.role"
        :tone="organization.role === 'owner' ? 'brand' : 'neutral'"
        >{{ organization.role === "owner" ? t("ownerRole") : t("memberRole") }}</StatusBadge
      >
      <RouterLink class="btn btn-sm" to="/organizations"
        ><AppIcon name="arrowLeft" />{{ t("organizations") }}</RouterLink
      >
    </header>
    <StatusState :loading="loading" :error="error" @retry="load" />
    <div v-if="!loading && !error" class="organization-layout">
      <nav class="organization-nav" :aria-label="t('organizationNavigation')">
        <a class="workspace-nav-item is-selected" href="#organization-overview"
          ><AppIcon name="home" />{{ t("overview") }}</a
        >
        <a class="workspace-nav-item" href="#organization-members"
          ><AppIcon name="person" />{{ t("members") }}
          <StatusBadge>{{ members.length }}</StatusBadge></a
        >
      </nav>
      <div class="organization-content">
        <section id="organization-overview" class="workspace-panel organization-overview-panel">
          <div class="workspace-panel-heading">
            <div>
              <h3>{{ t("organizationOverview") }}</h3>
              <p class="muted">{{ t("organizationOverviewHint") }}</p>
            </div>
          </div>
          <div class="organization-overview-body">
            <div>
              <span class="muted">{{ t("organizationName") }}</span
              ><strong>{{ organization?.displayName }}</strong>
            </div>
            <div>
              <span class="muted">{{ t("slug") }}</span
              ><strong class="mono">{{ organization?.slug }}</strong>
            </div>
            <div>
              <span class="muted">{{ t("yourRole") }}</span
              ><strong>{{
                organization?.role === "owner" ? t("ownerRole") : t("memberRole")
              }}</strong>
            </div>
          </div>
        </section>
        <section id="organization-members" class="workspace-panel organization-members-panel">
          <div class="workspace-panel-heading">
            <div>
              <h3>{{ t("members") }}</h3>
              <p class="muted">{{ t("organizationMembersHint") }}</p>
            </div>
            <StatusBadge>{{ members.length }}</StatusBadge>
          </div>
          <div v-for="member in members" :key="member.identifier" class="organization-member-row">
            <span class="organization-member-avatar"><AppIcon name="person" /></span
            ><span class="organization-member-name">{{ member.identifier }}</span
            ><StatusBadge :tone="member.role === 'owner' ? 'brand' : 'neutral'">{{
              member.role === "owner" ? t("ownerRole") : t("memberRole")
            }}</StatusBadge>
            <ConfirmButton
              v-if="organization?.role === 'owner'"
              size="small"
              tone="secondary"
              :label="removingIdentifier === member.identifier ? t('loading') : t('removeMember')"
              :accessible-name="`${t('removeMember')} · ${member.identifier}`"
              :prompt="t('confirmRemoveMember')"
              :disabled="Boolean(removingIdentifier)"
              @confirm="removeMember(member)"
            />
          </div>
          <NoticeBar v-if="memberNotice" intent="success">{{ memberNotice }}</NoticeBar>
          <NoticeBar v-if="revocationIncomplete" intent="warning">{{
            t("revocationIncomplete")
          }}</NoticeBar>
          <div v-if="!members.length" class="settings-empty-state">
            {{ t("organizationEmptyMembers") }}
          </div>
        </section>
        <section
          v-if="organization?.role === 'owner'"
          class="workspace-panel organization-add-member"
        >
          <div class="workspace-panel-heading">
            <div>
              <h3>{{ t("addMember") }}</h3>
              <p class="muted">{{ t("addMemberHint") }}</p>
            </div>
          </div>
          <form class="form-stack organization-member-form" @submit.prevent="addMember">
            <TextField v-model="form.identifier" required>{{ t("memberIdentifier") }}</TextField>
            <SelectField
              :model-value="form.role"
              :label="t('role')"
              @update:model-value="form.role = oneOf(roles, $event, 'member')"
            >
              <option value="member">{{ t("memberRole") }}</option>
              <option value="owner">{{ t("ownerRole") }}</option>
            </SelectField>
            <NoticeBar v-if="formError" intent="error">{{ formError }}</NoticeBar>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit" :disabled="saving">
                {{ saving ? t("loading") : t("addMember") }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  </section>
</template>
