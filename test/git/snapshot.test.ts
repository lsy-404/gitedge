import { describe, expect, it } from "vitest";
import { repositorySnapshot } from "../../workers/git/src/snapshot";
import { FixtureArtifacts } from "../support/artifacts";

describe("workflow discovery snapshots", () => {
  it("reads workflow definitions independently of repository assets that exceed container limits", async () => {
    const artifacts = new FixtureArtifacts();
    await artifacts.create("workflow-sources");
    const oid = await artifacts.seedFiles("workflow-sources", {
      ".github/workflows/verify.yml": "name: Runner\non: workflow_dispatch\n",
      ".gitedge/workflows/verify.yml": "name: Container\non: workflow_dispatch\n",
      "assets/large.bin": new Uint8Array(25 * 1024 * 1024),
      "README.md": "Source files are cloned by the runner.\n",
    });
    using repo = await artifacts.get("workflow-sources");
    const snapshot = await repositorySnapshot(repo, oid, true);
    expect(snapshot.oid).toBe(oid);
    expect(snapshot.files.map((file) => file.path).sort()).toEqual([
      ".gitedge/workflows/verify.yml",
      ".github/workflows/verify.yml",
    ]);
    await expect(repositorySnapshot(repo, oid)).rejects.toThrow("24 MiB");
  });
});
