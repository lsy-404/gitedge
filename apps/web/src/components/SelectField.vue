<script setup lang="ts">
import { useId } from "vue";
import AppIcon from "./AppIcon.vue";
defineProps<{ label: string; required?: boolean; disabled?: boolean }>();
const model = defineModel<string>({ required: true });
const id = useId();
</script>
<template>
  <label class="select-field" :for="id"
    ><span class="field-label">{{ label }}</span
    ><span class="select-control"
      ><select :id="id" v-model="model" :required="required" :disabled="disabled">
        <slot /></select
      ><AppIcon name="chevron" :size="12" /></span
  ></label>
</template>
