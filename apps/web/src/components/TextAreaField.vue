<script setup lang="ts">
import { useId } from "vue";
defineOptions({ inheritAttrs: false });
defineProps<{ label: string; required?: boolean; id?: string }>();
const model = defineModel<string>({ required: true });
const generatedId = useId();
</script>
<template>
  <label class="textarea-field" :class="$attrs.class" :for="id ?? generatedId">
    <span class="field-label">{{ label }}</span>
    <textarea v-bind="$attrs" :id="id ?? generatedId" v-model="model" :required="required" />
  </label>
</template>
