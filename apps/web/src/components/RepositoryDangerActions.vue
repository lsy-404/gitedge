<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { sessionState } from "../lib/session";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import TypeToConfirm from "./TypeToConfirm.vue";

const props = defineProps<{ repository: Repository; canManage: boolean }>();
const { t } = useI18n();
const router = useRouter();
const targets = ref<string[]>([]);
const target = ref("");
const transferring = ref(false);
const deleting = ref(false);
const transferOpen = ref(false);
const error = ref("");
const warning = ref("");
const fullName = computed(() => `${props.repository.owner}/${props.repository.name}`);

async function loadTargets() {
  try {
    const organizations = await api.organizations();
    const own = sessionState.user?.identifier;
    targets.value = [
      ...(own ? [own] : []),
      ...organizations.filter((item) => item.role === "owner").map((item) => item.slug),
    ].filter((slug) => slug.toLowerCase() !== props.repository.owner.toLowerCase());
    target.value = targets.value[0] ?? "";
  } catch {
    targets.value = [];
  }
}

async function transfer() {
  if (!target.value || transferring.value) return;
  transferring.value = true;
  error.value = "";
  warning.value = "";
  try {
    const moved = await api.transferRepository(props.repository.id, {
      owner: target.value,
      confirm: fullName.value,
    });
    if (moved.revocationIncomplete) warning.value = t("revocationIncomplete");
    await router.replace(
      `/${encodeURIComponent(moved.owner)}/${encodeURIComponent(moved.name)}/settings`
    );
  } catch (cause) {
    error.value = errorMessage(cause, t, {
      403: "lifecycleTransferForbidden",
      409: "lifecycleTransferConflict",
    });
  } finally {
    transferring.value = false;
  }
}

async function remove() {
  if (deleting.value) return;
  deleting.value = true;
  error.value = "";
  try {
    await api.deleteRepository(props.repository.id, fullName.value);
    await router.replace("/dashboard");
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    deleting.value = false;
  }
}

onMounted(loadTargets);
</script>

<template>
  <div class="danger-actions">
    <div class="box-row settings-row">
      <div class="row-copy">
        <strong>{{ t("lifecycleTransferTitle") }}</strong>
        <p>{{ t("lifecycleTransferHint") }}</p>
      </div>
      <div class="danger-control">
        <p v-if="!targets.length" class="muted">{{ t("lifecycleTransferNoTargets") }}</p>
        <template v-else>
          <SelectField
            v-model="target"
            :label="t('lifecycleTransferTarget')"
            :disabled="!canManage"
          >
            <option v-for="slug in targets" :key="slug" :value="slug">{{ slug }}</option>
          </SelectField>
          <FluentButton
            v-if="!transferOpen"
            type="button"
            tone="danger"
            :disabled="!canManage"
            @click="transferOpen = true"
          >
            {{ t("lifecycleTransferAction") }}
          </FluentButton>
          <TypeToConfirm
            v-else
            :expected="fullName"
            :action-label="t('lifecycleTransferConfirm', { owner: target })"
            :busy="transferring"
            :disabled="!canManage"
            @confirm="transfer"
          />
        </template>
      </div>
    </div>
    <div class="box-row settings-row">
      <div class="row-copy">
        <strong>{{ t("lifecycleDeleteTitle") }}</strong>
        <p>{{ t("lifecycleDeleteHint") }}</p>
      </div>
      <TypeToConfirm
        :expected="fullName"
        :action-label="t('lifecycleDeleteAction')"
        :busy="deleting"
        :disabled="!canManage"
        @confirm="remove"
      />
    </div>
    <div v-if="error || warning" class="box-form">
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <NoticeBar v-if="warning" intent="warning">{{ warning }}</NoticeBar>
    </div>
  </div>
</template>

<style scoped>
.danger-control {
  display: grid;
  gap: var(--space-3);
  justify-items: start;
  min-width: 0;
}
</style>
