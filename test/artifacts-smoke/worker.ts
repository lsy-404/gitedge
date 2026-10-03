import { listArtifactRefs, readArtifactTree, artifactGraph } from "../../workers/git/src/read";
import { compareArtifacts } from "../../workers/git/src/compare";
import { mergeArtifacts, GitMergeInputSchema } from "../../workers/git/src/merge";

export default {
  async fetch(request: Request, env: { ARTIFACTS: Artifacts }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/repos") {
      const input: unknown = await request.json();
      if (
        !input ||
        typeof input !== "object" ||
        !("name" in input) ||
        typeof input.name !== "string" ||
        !/^smoke-[a-z0-9-]+$/.test(input.name)
      )
        return new Response("Invalid smoke repository name", { status: 400 });
      return Response.json(await env.ARTIFACTS.create(input.name), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const name = url.searchParams.get("name");
    if (
      name &&
      name.startsWith("smoke-") &&
      ["/fork", "/refs", "/tree", "/graph", "/compare", "/merge"].includes(url.pathname)
    ) {
      using repo = await env.ARTIFACTS.get(name);
      if (url.pathname === "/fork" && request.method === "POST")
        return Response.json(await repo.fork(`${name}-session`));
      if (url.pathname === "/refs") return Response.json(await listArtifactRefs(repo));
      if (url.pathname === "/tree") return Response.json(await readArtifactTree(repo, "main", ""));
      if (url.pathname === "/graph")
        return Response.json(await artifactGraph(repo, await listArtifactRefs(repo), [], 100));
      if (url.pathname === "/compare" || url.pathname === "/merge") {
        using head = await env.ARTIFACTS.get(`${name}-session`);
        if (url.pathname === "/compare")
          return Response.json(await compareArtifacts(repo, head, "main", "main"));
        const input = GitMergeInputSchema.safeParse(await request.json());
        if (!input.success) return new Response("Invalid merge request", { status: 400 });
        return Response.json(
          await mergeArtifacts(repo, head, input.data, {
            requireLinearHistory: false,
            requireSignedCommits: false,
            verifySignature: async () => false,
            beforePush: async () => {},
          })
        );
      }
    }
    if (request.method === "GET" && url.pathname === "/readme" && name) {
      using repo = await env.ARTIFACTS.get(name);
      const file = await repo.readFile({ ref: "main", path: "README.md" });
      return file ? new Response(file.stream()) : new Response("Missing", { status: 404 });
    }
    return new Response("Smoke server", { status: 404 });
  },
};
