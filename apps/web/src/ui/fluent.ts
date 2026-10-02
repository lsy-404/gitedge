import type { Plugin } from "vue";
// Each import registers one custom element; only the elements the UI uses are bundled.
import "@fluentui/web-components/accordion.js";
import "@fluentui/web-components/accordion-item.js";
import "@fluentui/web-components/anchor-button.js";
import "@fluentui/web-components/avatar.js";
import "@fluentui/web-components/badge.js";
import "@fluentui/web-components/button.js";
import "@fluentui/web-components/checkbox.js";
import "@fluentui/web-components/counter-badge.js";
import "@fluentui/web-components/dialog.js";
import "@fluentui/web-components/dialog-body.js";
import "@fluentui/web-components/divider.js";
import "@fluentui/web-components/dropdown.js";
import "@fluentui/web-components/field.js";
import "@fluentui/web-components/link.js";
import "@fluentui/web-components/listbox.js";
import "@fluentui/web-components/menu.js";
import "@fluentui/web-components/menu-item.js";
import "@fluentui/web-components/menu-list.js";
import "@fluentui/web-components/message-bar.js";
import "@fluentui/web-components/option.js";
import "@fluentui/web-components/spinner.js";
import "@fluentui/web-components/tab.js";
import "@fluentui/web-components/tablist.js";
import "@fluentui/web-components/text-input.js";
import "@fluentui/web-components/textarea.js";
import "@fluentui/web-components/tooltip.js";
import { installColorScheme } from "./theme";

/** Registers the Fluent elements (via the imports above) and keeps the orange theme in sync with the OS. */
export const fluentUi: Plugin = {
  install() {
    installColorScheme();
  },
};
