<script setup lang="ts">
import { eventValue } from "../ui/formEvents";

/** Labelled Fluent textarea; see TextField for why the model is not bound with `v-model`. */
defineProps<{ label: string; required?: boolean }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <fluent-textarea
    :block="true"
    :value="model"
    :required="required"
    @input="model = eventValue($event)"
  >
    <span slot="label">{{ label }}</span>
  </fluent-textarea>
</template>
