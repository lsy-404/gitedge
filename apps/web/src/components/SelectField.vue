<script setup lang="ts">
import { useId } from "vue";
import AppIcon from "./AppIcon.vue";
defineProps<{ label: string; required?: boolean; disabled?: boolean; hint?: string }>();
const model = defineModel<string>({ required: true });
const id = useId();
</script>
<template>
  <label class="select-field" :for="id"
    ><span :id="`${id}-label`" class="field-label">{{ label }}</span
    ><span class="select-control"
      ><select
        :id="id"
        v-model="model"
        :required="required"
        :disabled="disabled"
        :aria-labelledby="hint ? `${id}-label` : undefined"
        :aria-describedby="hint ? `${id}-hint` : undefined"
      >
        <slot /></select
      ><AppIcon name="chevron" :size="12" /></span
    ><span v-if="hint" :id="`${id}-hint`" class="field-hint">{{ hint }}</span></label
  >
</template>
