<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, errorMessage, type PullRequest } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
const props = defineProps<{
  repositoryId: string;
  pull: PullRequest;
  headOid: string;
  canWrite: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const busy = ref(false);
const error = ref("");
async function changeLock() {
  busy.value = true;
  error.value = "";
  try {
    await api.setPullLock(
      props.repositoryId,
      props.pull.number,
      props.pull.lockedAt === null,
      props.headOid
    );
    emit("changed");
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="pull.state === 'open'" class="box">
    <div class="box-row">
      <strong>{{ t(pull.lockedAt === null ? "pullUnlocked" : "pullLocked") }}</strong>
      <p class="muted">{{ t(pull.lockedAt === null ? "pullLockHint" : "pullLockedHint") }}</p>
      <code v-if="pull.lockedHeadOid">{{ pull.lockedHeadOid.slice(0, 12) }}</code>
      <button
        v-if="canWrite"
        class="btn"
        type="button"
        :disabled="busy || !headOid"
        @click="changeLock"
      >
        {{ t(pull.lockedAt === null ? "pullLock" : "pullUnlock") }}
      </button>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    </div>
  </section>
</template>
