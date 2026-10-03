import type {
  RepositoryCommunity,
  RepositoryCommunityFile,
} from "../../../packages/contracts/src/repository-controls";
import type { GitEnv, GitRepositoryRow } from "./access";
import { readArtifactTree } from "./read";
interface Source {
  repositoryId: string;
  owner: string;
  repository: string;
  ref: string;
  inherited: boolean;
}
const MAX_DOCUMENT_BYTES = 200_000;
const definitions = [
  { kind: "readme", title: "README", names: ["README.md"], inherit: false },
  {
    kind: "license",
    title: "LICENSE",
    names: ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"],
    inherit: false,
  },
  { kind: "contributing", title: "CONTRIBUTING", names: ["CONTRIBUTING.md"], inherit: true },
  {
    kind: "code_of_conduct",
    title: "CODE_OF_CONDUCT",
    names: ["CODE_OF_CONDUCT.md"],
    inherit: true,
  },
  { kind: "security", title: "SECURITY", names: ["SECURITY.md"], inherit: true },
  { kind: "support", title: "SUPPORT", names: ["SUPPORT.md"], inherit: true },
  { kind: "codeowners", title: "CODEOWNERS", names: ["CODEOWNERS"], inherit: false },
  { kind: "funding", title: "FUNDING", names: ["FUNDING.yml"], inherit: true },
  { kind: "citation", title: "CITATION", names: ["CITATION.cff"], inherit: false },
  { kind: "accessibility", title: "ACCESSIBILITY", names: ["ACCESSIBILITY.md"], inherit: true },
];
async function document(
  repo: ArtifactsRepo,
  source: Source,
  path: string,
  kind: string,
  title: string
): Promise<RepositoryCommunityFile | null> {
  const file = await repo.readFile({ ref: source.ref, path });
  if (!file) return null;
  const content = await file.slice(0, MAX_DOCUMENT_BYTES).text();
  return { ...source, path, kind, title, content, truncated: file.size > MAX_DOCUMENT_BYTES };
}
async function firstDocument(
  repo: ArtifactsRepo,
  source: Source,
  paths: string[],
  kind: string,
  title: string
) {
  for (const path of paths) {
    const found = await document(repo, source, path, kind, title);
    if (found) return found;
  }
  return null;
}
async function issueTemplates(
  repo: ArtifactsRepo,
  source: Source
): Promise<{ files: RepositoryCommunityFile[]; hasLocalFolder: boolean; truncated: boolean }> {
  const tree = await readArtifactTree(repo, source.ref, ".github/ISSUE_TEMPLATE");
  if (!tree) return { files: [], hasLocalFolder: false, truncated: false };
  const entries = tree.entries.filter(
    (entry) =>
      entry.type === "blob" &&
      /\.(md|ya?ml)$/i.test(entry.name) &&
      !/^config\.ya?ml$/i.test(entry.name)
  );
  const files: RepositoryCommunityFile[] = [];
  for (const entry of entries.slice(0, 20)) {
    const item = await document(repo, source, entry.path, "issue_template", entry.name);
    if (item) files.push(item);
  }
  return { files, hasLocalFolder: tree.entries.length > 0, truncated: entries.length > 20 };
}
export async function repositoryCommunity(
  env: GitEnv,
  repository: GitRepositoryRow,
  repo: ArtifactsRepo,
  ref: string
): Promise<RepositoryCommunity> {
  const source: Source = {
    repositoryId: repository.id,
    owner: repository.owner,
    repository: repository.slug,
    ref,
    inherited: false,
  };
  const files: RepositoryCommunityFile[] = [];
  for (const def of definitions) {
    const paths =
      def.kind === "funding"
        ? [".github/FUNDING.yml"]
        : [".github/", "", "docs/"].flatMap((prefix) => def.names.map((name) => prefix + name));
    const file = await firstDocument(repo, source, paths, def.kind, def.title);
    if (file) files.push(file);
  }
  let templates = await issueTemplates(repo, source);
  let pullRequestTemplate = await firstDocument(
    repo,
    source,
    [
      ".github/PULL_REQUEST_TEMPLATE.md",
      "PULL_REQUEST_TEMPLATE.md",
      "docs/PULL_REQUEST_TEMPLATE.md",
    ],
    "pull_request_template",
    "Pull request template"
  );
  const shared = await env.DB.prepare(
    "SELECT r.id,r.artifact_name AS artifactName,r.default_branch AS defaultBranch FROM repositories r WHERE r.namespace_id=? AND r.slug='.github' AND r.visibility='public' AND r.id<>?"
  )
    .bind(repository.namespaceId, repository.id)
    .first<{ id: string; artifactName: string | null; defaultBranch: string }>();
  if (shared?.artifactName) {
    using defaults = await env.ARTIFACTS.get(shared.artifactName);
    const inherited: Source = {
      repositoryId: shared.id,
      owner: repository.owner,
      repository: ".github",
      ref: shared.defaultBranch,
      inherited: true,
    };
    for (const def of definitions.filter(
      (item) => item.inherit && !files.some((file) => file.kind === item.kind)
    )) {
      const paths =
        def.kind === "funding"
          ? [".github/FUNDING.yml"]
          : [".github/", "", "docs/"].flatMap((prefix) => def.names.map((name) => prefix + name));
      const file = await firstDocument(defaults, inherited, paths, def.kind, def.title);
      if (file) files.push(file);
    }
    if (!templates.hasLocalFolder) templates = await issueTemplates(defaults, inherited);
    if (!pullRequestTemplate)
      pullRequestTemplate = await firstDocument(
        defaults,
        inherited,
        [
          ".github/PULL_REQUEST_TEMPLATE.md",
          "PULL_REQUEST_TEMPLATE.md",
          "docs/PULL_REQUEST_TEMPLATE.md",
        ],
        "pull_request_template",
        "Pull request template"
      );
  }
  return {
    files,
    issueTemplates: templates.files,
    pullRequestTemplate,
    truncated:
      templates.truncated ||
      files.some((file) => file.truncated) ||
      templates.files.some((file) => file.truncated) ||
      Boolean(pullRequestTemplate?.truncated),
  };
}
