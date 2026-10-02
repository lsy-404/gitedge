import type { Plugin } from "vue";
// Each import registers one custom element; only the elements the UI uses are bundled.
import "@fluentui/web-components/accordion.js";
import "@fluentui/web-components/accordion-item.js";
import "@fluentui/web-components/avatar.js";
import "@fluentui/web-components/badge.js";
import "@fluentui/web-components/button.js";
import "@fluentui/web-components/checkbox.js";
import "@fluentui/web-components/dialog.js";
import "@fluentui/web-components/dialog-body.js";
import "@fluentui/web-components/field.js";
import "@fluentui/web-components/link.js";
import "@fluentui/web-components/message-bar.js";
import "@fluentui/web-components/spinner.js";
import { installColorScheme } from "./theme";

export const fluentUi: Plugin = {
  install() {
    installColorScheme();
  },
};
