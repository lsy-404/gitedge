<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  API_OPERATIONS,
  MCP_PATH,
  OPENAPI_METHOD_KEYS,
  OPENAPI_PATH,
  buildOpenApiDocument,
  type ApiOperation,
} from "../../../../packages/contracts/src/openapi";
import StatusBadge from "../components/StatusBadge.vue";
import { zhOperationSummaries, zhTagNames } from "../i18n/apiOperations";
import "../styles/workspace.css";

interface OperationView {
  operation: ApiOperation;
  summary: string;
  parameters: { name: string; location: string; required: boolean; description: string }[];
  body: string | null;
}

const { t, locale } = useI18n();
const origin = window.location.origin;
const document = buildOpenApiDocument(origin);

function view(operation: ApiOperation): OperationView {
  const entry = document.paths[operation.path]?.[OPENAPI_METHOD_KEYS[operation.method]];
  return {
    operation,
    summary:
      (locale.value === "zh-CN" ? zhOperationSummaries[operation.operationId] : undefined) ??
      operation.summary,
    parameters: (entry?.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      location: parameter.in,
      required: parameter.required,
      description: parameter.description ?? "",
    })),
    body: entry?.requestBody
      ? JSON.stringify(entry.requestBody.content["application/json"].schema, null, 2)
      : null,
  };
}

const groups = computed(() => {
  const byTag = new Map<string, OperationView[]>();
  for (const operation of API_OPERATIONS) {
    const list = byTag.get(operation.tag) ?? [];
    list.push(view(operation));
    byTag.set(operation.tag, list);
  }
  return [...byTag.entries()].map(([tag, operations]) => ({
    tag,
    title: (locale.value === "zh-CN" ? zhTagNames[tag] : undefined) ?? tag,
    operations,
  }));
});
</script>

<template>
  <section class="api-docs-page">
    <header class="workspace-page-heading">
      <div>
        <h1>{{ t("apiDocsTitle") }}</h1>
        <p class="muted">{{ t("apiDocsDescription") }}</p>
      </div>
      <a class="btn" :href="OPENAPI_PATH" download="gitedge-openapi.json">{{
        t("apiDocsDownload")
      }}</a>
    </header>
    <section class="box" aria-labelledby="api-docs-access">
      <header class="box-header">
        <h2 id="api-docs-access">{{ t("apiDocsAccessTitle") }}</h2>
      </header>
      <div class="box-row api-docs-access">
        <p>{{ t("apiDocsAuth") }}</p>
        <code>Authorization: Bearer gep_…</code>
        <p>{{ t("apiDocsMcp") }}</p>
        <code>{{ origin }}{{ MCP_PATH }}</code>
        <RouterLink to="/settings/account?section=tokens&mcp=1">{{
          t("apiDocsCreateToken")
        }}</RouterLink>
      </div>
    </section>
    <section
      v-for="group in groups"
      :key="group.tag"
      class="box"
      :aria-labelledby="`api-tag-${group.tag}`"
    >
      <header class="box-header">
        <h2 :id="`api-tag-${group.tag}`">{{ group.title }}</h2>
      </header>
      <article
        v-for="item in group.operations"
        :key="item.operation.operationId"
        class="box-row api-operation"
      >
        <div class="api-operation-line">
          <StatusBadge :tone="item.operation.method === 'GET' ? 'neutral' : 'brand'">{{
            item.operation.method
          }}</StatusBadge>
          <code class="api-operation-path">{{ item.operation.path }}</code>
        </div>
        <p>{{ item.summary }}</p>
        <p class="muted api-operation-meta">
          <span v-if="item.operation.scope">{{
            t("apiDocsScope", { scope: item.operation.scope })
          }}</span>
          <span v-else>{{ t("apiDocsNoScope") }}</span>
          <span v-if="item.operation.anonymous">{{ t("apiDocsAnonymous") }}</span>
        </p>
        <details v-if="item.parameters.length || item.body">
          <summary>{{ t("apiDocsDetails") }}</summary>
          <table v-if="item.parameters.length" class="api-parameters">
            <caption class="visually-hidden">
              {{
                t("apiDocsParameters")
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ t("apiDocsParameter") }}</th>
                <th scope="col">{{ t("apiDocsLocation") }}</th>
                <th scope="col">{{ t("apiDocsRequired") }}</th>
                <th scope="col">{{ t("apiDocsParameterDescription") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="parameter in item.parameters" :key="parameter.name">
                <td>
                  <code>{{ parameter.name }}</code>
                </td>
                <td>
                  {{ parameter.location === "path" ? t("apiDocsInPath") : t("apiDocsInQuery") }}
                </td>
                <td>{{ parameter.required ? t("apiDocsYes") : t("apiDocsNo") }}</td>
                <td>{{ parameter.description }}</td>
              </tr>
            </tbody>
          </table>
          <template v-if="item.body">
            <h3>{{ t("apiDocsBody") }}</h3>
            <pre class="api-schema"><code>{{ item.body }}</code></pre>
          </template>
        </details>
      </article>
    </section>
  </section>
</template>

<style scoped>
.api-docs-page {
  display: grid;
  gap: var(--space-4);
  width: min(960px, calc(100% - var(--page-gutter, var(--space-6)) * 2));
  margin: var(--space-6) auto var(--space-8);
}
.api-docs-access {
  display: grid;
  gap: var(--space-2);
}
.api-docs-access code,
.api-operation-path {
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
}
.api-operation {
  display: grid;
  gap: var(--space-2);
}
.api-operation p {
  margin: 0;
}
.api-operation-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.api-operation-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--font-size-meta);
}
.api-operation h3 {
  margin: var(--space-3) 0 var(--space-2);
  font-size: var(--font-size-body);
}
.api-parameters {
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-size: var(--font-size-meta);
}
.api-parameters th,
.api-parameters td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  vertical-align: top;
}
.api-schema {
  max-height: 320px;
  margin: 0;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  font-family: var(--font-mono);
  font-size: var(--font-size-meta);
}
</style>
