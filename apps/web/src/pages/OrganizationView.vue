<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, type Organization, type OrganizationMember, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import AppIcon from "../components/AppIcon.vue";
import AuditLogList from "../components/AuditLogList.vue";
import MemberInvitations from "../components/MemberInvitations.vue";
import ConfirmButton from "../components/ConfirmButton.vue";
import NoticeBar from "../components/NoticeBar.vue";
import ReauthPrompt from "../components/ReauthPrompt.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { oneOf } from "../ui/formEvents";
import StatusState from "../components/StatusState.vue";
import TypeToConfirm from "../components/TypeToConfirm.vue";
import RepositoryImportDialog from "../components/RepositoryImportDialog.vue";
import "../styles/workspace.css";
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const roles = ["member", "owner"] as const;
const slug = computed(() => String(route.params.slug));
const membersSelected = computed(() => route.hash === "#organization-members");
const organization = ref<Organization | null>(null);
const members = ref<OrganizationMember[]>([]);
const loading = ref(true);
const error = ref("");
const memberError = ref("");
const deleting = ref(false);
const deleteError = ref("");
const removingIdentifier = ref("");
const memberNotice = ref("");
const revocationIncomplete = ref(false);
const showImport = ref(false);
let loadVersion = 0;
const roleOptions = computed(() => [
  { value: "member", label: t("memberRole") },
  { value: "owner", label: t("ownerRole") },
]);
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
async function changeRole(member: OrganizationMember, value: string) {
  const role = oneOf(roles, value, member.role);
  if (role === member.role || removingIdentifier.value) return;
  memberError.value = "";
  memberNotice.value = "";
  try {
    await api.updateOrganizationMember(slug.value, member.identifier, role);
    memberNotice.value = t("organizationMemberRoleChanged");
    await load();
  } catch (cause) {
    memberError.value = errorMessage(cause, t, {}, "organizationMemberRoleError");
  }
}
async function removeMember(member: OrganizationMember) {
  if (removingIdentifier.value) return;
  const target = slug.value;
  removingIdentifier.value = member.identifier;
  memberError.value = "";
  memberNotice.value = "";
  revocationIncomplete.value = false;
  try {
    revocationIncomplete.value = await api.removeOrganizationMember(target, member.identifier);
    memberNotice.value = t("organizationMemberRemoved");
    await load();
    if (error.value && target === slug.value) await router.replace("/organizations");
  } catch (cause) {
    memberError.value = errorMessage(cause, t, {}, "organizationMemberRemoveError");
  } finally {
    removingIdentifier.value = "";
  }
}
const reauth = useReauthRetry();
async function deleteOrganization() {
  if (deleting.value) return;
  const target = slug.value;
  deleting.value = true;
  deleteError.value = "";
  try {
    await api.deleteOrganization(target, target);
    await router.replace("/organizations");
  } catch (cause) {
    if (reauth.intercept(cause, deleteOrganization)) return;
    deleteError.value = errorMessage(cause, t, { 409: "organizationDeleteBlocked" });
  } finally {
    deleting.value = false;
  }
}
watch(
  slug,
  () => {
    deleteError.value = "";
    memberError.value = "";
    memberNotice.value = "";
    revocationIncomplete.value = false;
    void load();
  },
  { immediate: true }
);
</script>
<template>
  <section class="workspace-page organization-page">
    <header class="box organization-banner">
      <span class="organization-avatar">{{
        (organization?.displayName || slug).slice(0, 1).toUpperCase()
      }}</span>
      <div class="organization-banner-main">
        <h1>{{ organization?.displayName || slug }}</h1>
        <p>{{ organization?.description || t("noDescription") }}</p>
      </div>
      <StatusBadge
        v-if="organization?.role"
        :tone="organization.role === 'owner' ? 'brand' : 'neutral'"
        >{{ organization.role === "owner" ? t("ownerRole") : t("memberRole") }}</StatusBadge
      >
      <button
        v-if="organization?.role === 'owner'"
        class="btn btn-sm"
        type="button"
        @click="showImport = true"
      >
        <AppIcon name="repo" />{{ t("importRepository") }}
      </button>
      <RouterLink class="btn btn-sm" to="/organizations"
        ><AppIcon name="arrowLeft" />{{ t("organizations") }}</RouterLink
      >
    </header>
    <RepositoryImportDialog
      :open="showImport"
      :owners="[{ value: slug, label: organization?.displayName || slug }]"
      :default-owner="slug"
      @close="showImport = false"
      @imported="load"
    />
    <StatusState :loading="loading" :error="error" @retry="load" />
    <div v-if="!loading && !error" class="organization-layout">
      <nav class="box organization-nav" :aria-label="t('organizationNavigation')">
        <a
          class="workspace-nav-item"
          href="#organization-overview"
          :aria-current="membersSelected ? undefined : 'location'"
          ><AppIcon name="home" />{{ t("overview") }}</a
        >
        <a
          class="workspace-nav-item"
          href="#organization-members"
          :aria-current="membersSelected ? 'location' : undefined"
          ><AppIcon name="person" />{{ t("members") }}
          <StatusBadge>{{ members.length }}</StatusBadge></a
        >
      </nav>
      <div class="organization-content">
        <section id="organization-overview" class="box">
          <div class="box-header workspace-panel-heading">
            <div>
              <h2>{{ t("organizationOverview") }}</h2>
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
        <section id="organization-members" class="box">
          <div class="box-header workspace-panel-heading">
            <div>
              <h2>{{ t("members") }}</h2>
              <p class="muted">{{ t("organizationMembersHint") }}</p>
            </div>
            <StatusBadge>{{ members.length }}</StatusBadge>
          </div>
          <div
            v-for="member in members"
            :key="member.identifier"
            class="box-row organization-member-row"
          >
            <span class="organization-member-avatar"><AppIcon name="person" /></span
            ><span class="organization-member-name">{{ member.identifier }}</span
            ><SelectField
              v-if="organization?.role === 'owner'"
              :model-value="member.role"
              :label="t('role')"
              @update:model-value="changeRole(member, $event)"
            >
              <option value="member">{{ t("memberRole") }}</option>
              <option value="owner">{{ t("ownerRole") }}</option> </SelectField
            ><StatusBadge v-else :tone="member.role === 'owner' ? 'brand' : 'neutral'">{{
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
          <NoticeBar v-if="memberError" intent="error">{{ memberError }}</NoticeBar>
          <NoticeBar v-if="memberNotice" intent="success">{{ memberNotice }}</NoticeBar>
          <NoticeBar v-if="revocationIncomplete" intent="warning">{{
            t("revocationIncomplete")
          }}</NoticeBar>
          <div v-if="!members.length" class="settings-empty">
            {{ t("organizationEmptyMembers") }}
          </div>
        </section>
        <MemberInvitations
          v-if="organization?.role === 'owner'"
          :scope="{ kind: 'organization', slug }"
          :roles="roleOptions"
          default-role="member"
          :can-manage="true"
        />
        <section v-if="organization?.role === 'owner'" class="box">
          <div class="box-header workspace-panel-heading">
            <div>
              <h2>{{ t("auditLogTitle") }}</h2>
              <p class="muted">{{ t("auditOrganizationHint") }}</p>
            </div>
          </div>
          <AuditLogList
            :load="(cursor) => api.organizationAuditLog(slug, cursor)"
            :reload-key="slug"
          />
        </section>
        <section v-if="organization?.role === 'owner'" class="box box-danger">
          <div class="box-header workspace-panel-heading">
            <div>
              <h2>{{ t("dangerZone") }}</h2>
              <p class="muted">{{ t("organizationDeleteHint") }}</p>
            </div>
          </div>
          <div class="box-form">
            <TypeToConfirm
              :expected="slug"
              :action-label="t('organizationDeleteAction')"
              :busy="deleting"
              @confirm="deleteOrganization"
            />
            <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
            <NoticeBar v-if="deleteError" intent="error">{{ deleteError }}</NoticeBar>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
