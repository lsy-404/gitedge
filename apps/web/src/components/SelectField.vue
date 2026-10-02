<script setup lang="ts">
import { DropdownOption } from "@fluentui/web-components/option/class.js";
import { onMounted, onUpdated, ref, useId } from "vue";
import { eventValue } from "../ui/formEvents";

/**
 * Labelled Fluent dropdown. Options are `<fluent-option :value>` children. The control reports its
 * selection through a native `change` event, so the model is updated from the event target.
 */
defineProps<{ label: string; required?: boolean; disabled?: boolean }>();
const model = defineModel<string>({ required: true });
const id = useId();
const root = ref<HTMLElement | null>(null);

function select(event: Event) {
  model.value = eventValue(event);
}

/**
 * Setting the dropdown's `value` before its listbox has connected selects nothing, so the model is
 * applied through each option's `selected` state, which the listbox reads when it connects.
 */
function syncSelection() {
  for (const option of root.value?.querySelectorAll("fluent-option") ?? []) {
    if (option instanceof DropdownOption) option.selected = option.value === model.value;
  }
}
onMounted(syncSelection);
onUpdated(syncSelection);
</script>

<template>
  <fluent-field ref="root" class="select-field">
    <label slot="label" :for="id">{{ label }}</label>
    <fluent-dropdown
      :id="id"
      slot="input"
      :value="model"
      :required="required"
      :disabled="disabled"
      @change="select"
    >
      <fluent-listbox><slot /></fluent-listbox>
    </fluent-dropdown>
  </fluent-field>
</template>
