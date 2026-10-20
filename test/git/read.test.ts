import { afterEach, expect, it, vi } from "vitest";
import { refContainsCommit, resolveCommit } from "../../workers/git/src/read";
import { memoryHistory } from "../support/memory-history";

afterEach(() => vi.unstubAllGlobals());

it("resolves qualified branches and annotated tags independently of short-name collisions", async () => {
  const history = await memoryHistory([
    { message: "base", files: { "README.md": "base" } },
    { message: "branch", files: { "README.md": "branch" } },
    { message: "tag", files: { "README.md": "tag" }, parents: [0] },
  ]);
  const branch = history.oids[1]!,
    tag = history.oids[2]!;
  const repo = {
    ...history.repo,
    info: async () => ({
      name: "qualified-refs",
      remote: "https://artifacts.example.test/repo.git",
    }),
    createToken: async () => ({ id: "read-token", plaintext: "fixture-token" }),
    revokeToken: async () => true,
    log: (options: Parameters<ArtifactsRepo["log"]>[0]) =>
      history.repo.log({
        ...options,
        ref: options?.ref === "main" ? branch : options?.ref,
      }),
  } as ArtifactsRepo;
  const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes("info/refs")
        ? new Response(
            pkt("version 2\n") + pkt("ls-refs=unborn\n") + pkt("fetch=shallow\n") + "0000",
            {
              headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
            }
          )
        : new Response(
            pkt(`${branch} refs/heads/main\n`) +
              pkt(`${"e".repeat(40)} refs/tags/main peeled:${tag}\n`) +
              "0000",
            {
              headers: { "Content-Type": "application/x-git-upload-pack-result" },
            }
          );
    })
  );
  for (const [ref, expected, other] of [
    ["refs/heads/main", branch, tag],
    ["refs/tags/main", tag, branch],
  ]) {
    expect((await resolveCommit(repo, ref!))?.hash).toBe(expected);
    expect(await refContainsCommit(repo, ref!, expected!)).toBe(true);
    expect(await refContainsCommit(repo, ref!, other!)).toBe(false);
  }
  expect(await resolveCommit(repo, "refs/heads/missing")).toBeNull();
  expect(await refContainsCommit(repo, "refs/heads/missing", branch)).toBe(false);
});
