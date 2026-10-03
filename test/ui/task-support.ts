import { createApp, defineComponent, h, nextTick, type Component, type VNode } from "vue";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import type { Actor, Repository } from "../../packages/contracts/src/forge";
import type {
  Task,
  TaskDetail,
  TaskDocument,
  TaskDocumentKind,
} from "../../packages/contracts/src/tasks";

export const human: Actor = { kind: "user", id: "user-1", name: "example-user" };
export const agentActor: Actor = { kind: "agent", id: "agent-1", name: "builder" };

export const repository: Repository = {
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "acme",
  name: "project",
  slug: "project",
  artifactName: "acme/project",
  remote: "https://git.example/acme/project.git",
  description: "A test repository",
  visibility: "public",
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 2,
  canWrite: true,
  archived: false,
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  tasksEnabled: true,
  agentsEnabled: true,
  deploymentsEnabled: true,
  graphEnabled: true,
  actionsEnabled: true,
  actionsNetworkEnabled: false,
  onlineEditingEnabled: true,
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
  deleteBranchOnMerge: false,
  requiredApprovals: 0,
  requirePassingChecks: false,
};

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    number: 1,
    type: "Feature",
    title: "Agent memory",
    motivation: "Agents need durable context",
    description: "Store project memory per repository",
    status: "in_progress",
    assignee: null,
    actor: human,
    progress: { total: 5, done: 2, percent: 40 },
    commitCount: 1,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

export function taskDocument(
  kind: TaskDocumentKind,
  overrides: Partial<TaskDocument> = {}
): TaskDocument {
  return {
    kind,
    content: kind === "plan" ? "## Plan\n\n- [ ] first step" : "",
    revision: kind === "plan" ? 2 : 0,
    actor: human,
    updatedAt: 30,
    ...overrides,
  };
}

export function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...task(),
    documents: {
      plan: taskDocument("plan"),
      findings: taskDocument("findings"),
      progress: taskDocument("progress"),
    },
    links: [],
    commits: [],
    ...overrides,
  };
}

/** Lets pending promises, Vue renders and timers run. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function control(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Expected control: ${selector}`);
  return found;
}

export function findButton(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button.fluent-button")).find(
    (button) => button.textContent?.replace(/\s+/g, " ").includes(text)
  );
  if (!found) throw new Error(`Could not find button containing: ${text}`);
  return found;
}

export function findByLabel(root: ParentNode, label: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Could not find element labelled: ${label}`);
  return found;
}

/** Sets a native control's value and dispatches its expected event. */
export function fill(field: HTMLElement, value: string): void {
  Reflect.set(field, "value", value);
  field.dispatchEvent(
    new Event(field.localName === "select" ? "change" : "input", { bubbles: true })
  );
}

export function fieldValue(field: HTMLElement): string {
  const property = Reflect.get(field, "value");
  return typeof property === "string" ? property : (field.getAttribute("value") ?? "");
}

export function isDisabled(field: HTMLElement): boolean {
  if (Reflect.get(field, "disabled") === true) return true;
  const attribute = field.getAttribute("disabled");
  return attribute !== null && attribute !== "false";
}

export function submit(form: HTMLElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

const pendingUnmounts: Array<() => void> = [];
let routeSequence = 0;

/** Mounts `render` inside a throwaway route so route params and links behave as in the app. */
export async function mountAt(routePath: string, path: string, render: () => VNode) {
  setSession({ id: "user-1", identifier: "user@example.test" });
  const Host: Component = defineComponent({ setup: () => render });
  const routeName = `task-test-${routeSequence++}`;
  router.addRoute({
    path: routePath,
    alias: routePath.startsWith("/_verify/tasks")
      ? `/${repository.owner}/${repository.name}/tasks/:number?`
      : [],
    name: routeName,
    component: Host,
    meta: { public: true },
  });
  await router.push(path);
  await router.isReady();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(Host);
  app.use(router);
  app.use(i18n);
  app.use(fluentUi);
  app.mount(root);
  await settle();
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    app.unmount();
    root.remove();
    router.removeRoute(routeName);
  };
  pendingUnmounts.push(unmount);
  return { root, unmount };
}

export async function unmountAll(): Promise<void> {
  for (const unmount of pendingUnmounts.splice(0)) unmount();
  await router.push("/dashboard");
}

export { h };
