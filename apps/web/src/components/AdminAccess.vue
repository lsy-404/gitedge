<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField } from "@platform-kit/fluent/vue";
import type { AccessBan } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import SelectField from "./SelectField.vue";
import StatusState from "./StatusState.vue";

const { t, d } = useI18n();
const reauth = useReauthRetry();
const bans = ref<AccessBan[]>([]);
const rpm = ref("300");
const kind = ref<"user" | "ip">("ip");
const value = ref("");
const reason = ref("");
const duration = ref("never");
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const actionError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [items, settings] = await Promise.all([api.adminAccessBans(), api.adminIpRpm()]);
    bans.value = items;
    rpm.value = String(settings.rpm);
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

function expiry(): number | null {
  const milliseconds = Number(duration.value);
  return milliseconds > 0 ? Date.now() + milliseconds : null;
}

async function mutate(work: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    await work();
    await load();
  } catch (cause) {
    if (reauth.intercept(cause, () => mutate(work))) return;
    actionError.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}

function createBan(): void {
  const expiresAt = expiry();
  void mutate(async () => {
    await api.createAdminAccessBan({
      kind: kind.value,
      value: value.value,
      reason: reason.value,
      expiresAt,
    });
    value.value = "";
    reason.value = "";
  });
}

function saveRpm(): void {
  void mutate(() => api.updateAdminIpRpm({ rpm: Number(rpm.value) }));
}

function removeBan(ban: AccessBan): void {
  void mutate(() => api.removeAdminAccessBan(ban.id));
}

onMounted(load);
</script>

<template>
  <section class="box" aria-labelledby="admin-access-title">
    <header class="box-header">
      <h2 id="admin-access-title">{{ t("adminAccessTitle") }}</h2>
    </header>
    <p class="box-form muted">{{ t("adminAccessHint") }}</p>
    <div v-if="reauth.pending.value" class="box-form">
      <ReauthPrompt @confirmed="reauth.confirmed" />
    </div>
    <div v-if="actionError" class="box-form">
      <NoticeBar intent="error">{{ actionError }}</NoticeBar>
    </div>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <form class="box-form access-rpm" @submit.prevent="saveRpm">
        <FluentField
          v-model="rpm"
          :label="t('adminAccessRpm')"
          type="number"
          min="1"
          max="100000"
        />
        <FluentButton type="submit" :disabled="busy">{{ t("save") }}</FluentButton>
      </form>
      <form class="box-form access-ban-form" @submit.prevent="createBan">
        <SelectField v-model="kind" :label="t('adminAccessType')" :disabled="busy">
          <option value="ip">{{ t("adminAccessIp") }}</option>
          <option value="user">{{ t("adminAccessUser") }}</option>
        </SelectField>
        <FluentField
          v-model="value"
          :label="kind === 'ip' ? t('adminAccessAddress') : t('adminAccessUsername')"
          required
        />
        <FluentField v-model="reason" :label="t('adminAccessReason')" required maxlength="500" />
        <SelectField v-model="duration" :label="t('adminAccessDuration')" :disabled="busy">
          <option value="never">{{ t("adminAccessNoExpiry") }}</option>
          <option value="3600000">{{ t("adminAccessOneHour") }}</option>
          <option value="86400000">{{ t("adminAccessOneDay") }}</option>
          <option value="604800000">{{ t("adminAccessSevenDays") }}</option>
        </SelectField>
        <FluentButton
          type="submit"
          tone="danger"
          :disabled="busy || !value.trim() || !reason.trim()"
          >{{ t("adminAccessAddBan") }}</FluentButton
        >
      </form>
      <p v-if="!bans.length" class="settings-empty">{{ t("adminAccessEmpty") }}</p>
      <ul v-else class="settings-list">
        <li v-for="ban in bans" :key="ban.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ ban.value }} <span class="muted">{{ t(`adminAccessKind_${ban.kind}`) }}</span>
            </div>
            <div class="row-meta">
              <span>{{ ban.reason }}</span>
              <span>{{ t("adminAccessCreatedBy", { name: ban.createdBy }) }}</span>
              <span>{{
                ban.expiresAt
                  ? t("adminAccessExpires", { date: d(ban.expiresAt, "short") })
                  : t("adminAccessNoExpiry")
              }}</span>
            </div>
          </div>
          <ConfirmButton
            size="small"
            tone="secondary"
            :label="t('adminAccessRemove')"
            :accessible-name="`${t('adminAccessRemove')} · ${ban.value}`"
            :prompt="t('adminAccessRemovePrompt')"
            :disabled="busy"
            @confirm="removeBan(ban)"
          />
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.access-rpm,
.access-ban-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
  align-items: end;
}
</style>
