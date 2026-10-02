import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import { router } from "./router";
import { fluentUi } from "./ui/fluent";
import "./styles/main.css";

createApp(App).use(fluentUi).use(i18n).use(router).mount("#app");
