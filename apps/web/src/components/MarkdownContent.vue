<script lang="ts">
import MarkdownIt from "markdown-it";

/**
 * Raw HTML in the source is escaped, unsafe link schemes are rejected by markdown-it itself, and
 * images are disabled so a document cannot make the viewer's browser contact third-party hosts.
 */
const renderer = new MarkdownIt({ html: false, linkify: false }).disable("image");
const renderLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

/** Turns a leading `[ ]` or `[x]` in a list item into a read-only checkbox, as plans use them. */
renderer.core.ruler.after("inline", "task-list", (state) => {
  const { tokens } = state;
  for (let index = 2; index < tokens.length; index += 1) {
    const inline = tokens[index];
    if (
      inline.type !== "inline" ||
      tokens[index - 1].type !== "paragraph_open" ||
      tokens[index - 2].type !== "list_item_open"
    )
      continue;
    const first = inline.children?.[0];
    const marker = first?.type === "text" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
    if (!first || !marker) continue;
    first.content = first.content.slice(marker[0].length);
    const checkbox = new state.Token("html_inline", "", 0);
    checkbox.content = `<input type="checkbox" class="task-check" disabled${marker[1] === " " ? "" : " checked"}> `;
    inline.children?.unshift(checkbox);
    tokens[index - 2].attrJoin("class", "task-item");
  }
});

renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = String(tokens[index].attrGet("href") ?? "");
  if (/^https?:/i.test(href)) {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noreferrer noopener");
  }
  return renderLinkOpen(tokens, index, options, env, self);
};
</script>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ source: string }>();
const html = computed(() => renderer.render(props.source));
</script>

<template>
  <div class="markdown" v-html="html" />
</template>

<style scoped>
.markdown {
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.markdown > :deep(:first-child) {
  margin-top: 0;
}
.markdown > :deep(:last-child) {
  margin-bottom: 0;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) {
  margin: var(--spacingVerticalL) 0 var(--spacingVerticalS);
  font-weight: var(--fontWeightSemibold);
  line-height: 1.3;
}
.markdown :deep(h1) {
  font-size: var(--fontSizeBase500);
}
.markdown :deep(h2) {
  font-size: var(--fontSizeBase400);
}
.markdown :deep(h3),
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) {
  font-size: var(--fontSizeBase300);
}
.markdown :deep(p),
.markdown :deep(ul),
.markdown :deep(ol),
.markdown :deep(blockquote),
.markdown :deep(pre) {
  margin: 0 0 var(--spacingVerticalM);
}
.markdown :deep(ul),
.markdown :deep(ol) {
  padding-left: var(--spacingHorizontalXXL);
}
.markdown :deep(li.task-item) {
  list-style: none;
  margin-left: calc(var(--spacingHorizontalXL) * -1);
}
.markdown :deep(.task-check) {
  margin: 0 var(--spacingHorizontalXS) 0 0;
  vertical-align: middle;
  accent-color: var(--colorBrandBackground);
}
.markdown :deep(li + li) {
  margin-top: var(--spacingVerticalXXS);
}
.markdown :deep(code) {
  padding: 1px var(--spacingHorizontalXS);
  border-radius: var(--borderRadiusSmall);
  background: var(--colorNeutralBackground3);
  color: var(--colorNeutralForeground1);
  font-size: var(--fontSizeBase200);
}
.markdown :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  padding: var(--spacingVerticalM);
  border-radius: var(--borderRadiusMedium);
  background: var(--colorNeutralBackground3);
}
.markdown :deep(pre code) {
  padding: 0;
  background: none;
}
.markdown :deep(blockquote) {
  padding-left: var(--spacingHorizontalL);
  border-left: var(--strokeWidthThick) solid var(--colorNeutralStroke1);
  color: var(--colorNeutralForeground2);
}
.markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  margin: 0 0 var(--spacingVerticalM);
  border-collapse: collapse;
}
.markdown :deep(th),
.markdown :deep(td) {
  padding: var(--spacingVerticalXS) var(--spacingHorizontalM);
  border: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
  overflow-wrap: normal;
  text-align: start;
  vertical-align: top;
}
.markdown :deep(td:first-child) {
  white-space: nowrap;
}
.markdown :deep(th) {
  background: var(--colorNeutralBackground3);
  font-weight: var(--fontWeightSemibold);
  white-space: nowrap;
}
.markdown :deep(hr) {
  border: 0;
  border-top: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
  margin: var(--spacingVerticalL) 0;
}
</style>
