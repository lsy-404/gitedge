<script setup lang="ts">
import { useAttrs, useId } from "vue";
defineOptions({ inheritAttrs: false });
const props = defineProps<{ required?: boolean; id?: string; hint?: string }>();
const model = defineModel<string>({ required: true });
const attrs = useAttrs();
const generatedId = useId();
const fieldId = () => props.id ?? generatedId;
/** With a hint, the label span alone names the input and the hint describes it. */
function inputAttrs() {
  if (!props.hint) return attrs;
  return {
    ...attrs,
    "aria-labelledby": `${fieldId()}-label`,
    "aria-describedby": `${fieldId()}-hint`,
  };
}
</script>
<template>
  <label class="text-field" :class="$attrs.class" :for="fieldId()">
    <span :id="`${fieldId()}-label`" class="field-label"><slot /></span>
    <input v-bind="inputAttrs()" :id="fieldId()" v-model="model" :required="required" />
    <span v-if="hint" :id="`${fieldId()}-hint`" class="field-hint">{{ hint }}</span>
  </label>
</template>
