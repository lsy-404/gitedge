import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import { router } from "./router";
import { fluentUi } from "./ui/fluent";
import "./styles/main.css";
import "./styles/motion.css";
import { installFluentMotion } from "./ui/fluentMotion";

installFluentMotion();

const app = createApp(App).use(fluentUi).use(i18n).use(router);
void router.isReady().then(() => app.mount("#app"));
