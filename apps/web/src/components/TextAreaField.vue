<script setup lang="ts">
import { useAttrs, useId } from "vue";
defineOptions({ inheritAttrs: false });
const props = defineProps<{ label: string; required?: boolean; id?: string; hint?: string }>();
const model = defineModel<string>({ required: true });
const attrs = useAttrs();
const generatedId = useId();
const fieldId = () => props.id ?? generatedId;
/** With a hint, the label span alone names the textarea and the hint describes it. */
function textareaAttrs() {
  if (!props.hint) return attrs;
  return {
    ...attrs,
    "aria-labelledby": `${fieldId()}-label`,
    "aria-describedby": `${fieldId()}-hint`,
  };
}
</script>
<template>
  <label class="textarea-field" :class="$attrs.class" :for="fieldId()">
    <span :id="`${fieldId()}-label`" class="field-label">{{ label }}</span>
    <textarea v-bind="textareaAttrs()" :id="fieldId()" v-model="model" :required="required" />
    <span v-if="hint" :id="`${fieldId()}-hint`" class="field-hint">{{ hint }}</span>
  </label>
</template>
