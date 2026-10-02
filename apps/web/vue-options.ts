import type { Options as VueOptions } from "@vitejs/plugin-vue";

/** Fluent UI web components are native custom elements, not Vue components. */
export const vueOptions: VueOptions = {
  template: {
    compilerOptions: {
      isCustomElement: (tag) => tag.startsWith("fluent-"),
    },
  },
};
