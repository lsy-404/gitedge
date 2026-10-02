<script setup lang="ts">
import { eventValue } from "../ui/formEvents";

/**
 * Fluent text input whose default slot is the label. The model is bound with `:value` plus the
 * native `input` event: `v-model` assigns after the element connects, and Fluent resets values
 * written at that moment. `required` is a declared prop because a bare boolean attribute reaches
 * the element as "" and Fluent reads that as false.
 */
defineProps<{ required?: boolean }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <fluent-text-input :value="model" :required="required" @input="model = eventValue($event)"
    ><slot
  /></fluent-text-input>
</template>
