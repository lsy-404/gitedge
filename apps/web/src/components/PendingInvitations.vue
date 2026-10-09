<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { Invitation } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";

const emit = defineEmits<{ accepted: [] }>();
const { t, d } = useI18n();
const invitations = ref<Invitation[]>([]);
const busyId = ref("");
const error = ref("");

function target(item: Invitation): string {
  return item.repository
    ? `${item.repository.owner}/${item.repository.name}`
    : (item.organization ?? "");
}

function roleLabel(item: Invitation): string {
  return t(`inviteRole_${item.role}`);
}

async function load(): Promise<void> {
  try {
    invitations.value = await api.myInvitations();
  } catch {
    invitations.value = [];
  }
}

async function resolve(item: Invitation, action: "accept" | "decline"): Promise<void> {
  if (busyId.value) return;
  busyId.value = item.id;
  error.value = "";
  try {
    await api.resolveInvitation(item.id, action);
    await load();
    if (action === "accept") emit("accepted");
  } catch (cause) {
    error.value = errorMessage(cause, t, { 409: "inviteClosed" });
    await load();
  } finally {
    busyId.value = "";
  }
}

onMounted(load);
</script>

<template>
  <section
    v-if="invitations.length || error"
    class="box pending-invitations"
    aria-labelledby="pending-invitations-title"
  >
    <header class="box-header">
      <h2 id="pending-invitations-title">{{ t("invitationsPending") }}</h2>
      <StatusBadge>{{ invitations.length }}</StatusBadge>
    </header>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <ul class="settings-list">
      <li v-for="item in invitations" :key="item.id" class="box-row settings-item">
        <div class="settings-item-copy">
          <div class="row-title">
            {{
              t(
                item.kind === "organization"
                  ? "invitationToOrganization"
                  : "invitationToRepository",
                {
                  inviter: item.inviter,
                  target: target(item),
                }
              )
            }}
            <StatusBadge>{{ roleLabel(item) }}</StatusBadge>
          </div>
          <div class="row-meta">
            <span>{{ t("inviteExpires", { date: d(item.expiresAt, "long") }) }}</span>
          </div>
        </div>
        <div class="settings-actions">
          <FluentButton
            type="button"
            tone="primary"
            :busy="busyId === item.id"
            :disabled="Boolean(busyId)"
            @click="resolve(item, 'accept')"
            >{{ t("invitationAccept") }}</FluentButton
          >
          <FluentButton
            type="button"
            :disabled="Boolean(busyId)"
            @click="resolve(item, 'decline')"
            >{{ t("invitationDecline") }}</FluentButton
          >
        </div>
      </li>
    </ul>
  </section>
</template>
