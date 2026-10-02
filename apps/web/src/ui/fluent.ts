import type { Plugin } from "vue";
import {
  FluentButton,
  FluentCheckbox,
  FluentDialog,
  FluentNotice,
  FluentProgressRing,
  FluentTheme,
} from "@platform-kit/fluent/vue";

export const fluentUi: Plugin = {
  install(app) {
    app.component("FluentButton", FluentButton);
    app.component("FluentCheckbox", FluentCheckbox);
    app.component("FluentDialog", FluentDialog);
    app.component("FluentNotice", FluentNotice);
    app.component("FluentProgressRing", FluentProgressRing);
    app.component("FluentTheme", FluentTheme);
  },
};
