import { access, mkdtemp, mkdir, open, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneRunArtifacts, runArtifactRoots } from "../../scripts/runner-retention.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gitedge-retention-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function age(file: string, timestamp: number) {
  await utimes(file, timestamp / 1000, timestamp / 1000);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("runner artifact retention", () => {
  it("removes expired run directories and keeps recent and unrelated entries", async () => {
    const root = await temporaryDirectory();
    const expired = path.join(root, "run-expired");
    const recent = path.join(root, "run-recent");
    const unrelated = path.join(root, "credentials");
    await Promise.all([mkdir(expired), mkdir(recent), mkdir(unrelated)]);
    await Promise.all([
      writeFile(path.join(expired, "log"), "old"),
      writeFile(path.join(recent, "log"), "new"),
      writeFile(path.join(unrelated, "config"), "keep"),
    ]);
    const now = Date.now();
    await age(expired, now - 8 * 24 * 60 * 60 * 1000);

    await pruneRunArtifacts(
      [{ directory: root, match: (entry) => entry.name.startsWith("run-") }],
      { now }
    );

    await expect(rm(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(recent)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it("removes the oldest artifacts until the combined size is within the cap", async () => {
    const firstRoot = await temporaryDirectory();
    const secondRoot = await temporaryDirectory();
    const oldest = path.join(firstRoot, "run-oldest");
    const newest = path.join(secondRoot, "failed.log");
    await mkdir(oldest);
    await writeFile(path.join(oldest, "data"), Buffer.alloc(8));
    await writeFile(newest, Buffer.alloc(8));
    const now = Date.now();
    await age(oldest, now - 60_000);
    await age(newest, now - 30_000);

    await pruneRunArtifacts(
      [
        { directory: firstRoot, match: (entry) => entry.name.startsWith("run-") },
        { directory: secondRoot, match: (entry) => entry.name.endsWith(".log") },
      ],
      { now, maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 10 }
    );

    await expect(rm(oldest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(newest)).resolves.toBeUndefined();
  });

  it("does not follow symlinked roots or entries outside the owned directory", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "runs");
    const external = path.join(parent, "external");
    const link = path.join(root, "run-linked");
    await Promise.all([mkdir(root), mkdir(external)]);
    await writeFile(path.join(external, "keep"), "outside");
    await symlink(external, link, "junction");
    const linkedRoot = path.join(parent, "runs-link");
    await symlink(root, linkedRoot, "junction");

    await pruneRunArtifacts(
      [
        { directory: root, match: () => true },
        { directory: linkedRoot, match: () => true },
      ],
      { now: Date.now(), maxAgeMs: 0, maxBytes: 0 }
    );

    await expect(access(path.join(external, "keep"))).resolves.toBeUndefined();
    await expect(access(link)).resolves.toBeUndefined();
  });

  it("uses the explicit actions state path even with a custom broker state", async () => {
    const parent = await temporaryDirectory();
    const brokerState = path.join(parent, "custom-broker-state");
    const profile = { directory: path.join(parent, "profiles", "one") };
    const actionsState = path.join(parent, "shared-actions-state");

    const roots = runArtifactRoots(brokerState, [profile], actionsState);

    expect(roots.at(-1)?.directory).toBe(path.join(actionsState, "runs"));
  });

  it("cleans run data beneath a legitimate symlinked ancestor", async () => {
    const parent = await temporaryDirectory();
    const actualRoot = path.join(parent, "actual");
    const linkedRoot = path.join(parent, "linked");
    const runs = path.join(linkedRoot, "work", "actions", "runs");
    const expired = path.join(actualRoot, "work", "actions", "runs", "run-expired");
    await mkdir(expired, { recursive: true });
    await writeFile(path.join(expired, "log"), "old");
    await symlink(actualRoot, linkedRoot, "junction");
    const now = Date.now();
    await age(path.join(actualRoot, "work", "actions", "runs", "run-expired"), now - 8 * 86400000);

    await pruneRunArtifacts(
      [{ directory: runs, match: (entry) => entry.name.startsWith("run-") }],
      { now }
    );

    await expect(access(expired)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves run data untouched when another process holds the execution lock", async () => {
    const state = await temporaryDirectory();
    const runs = path.join(state, "runs");
    const oldRun = path.join(runs, "run-active");
    await mkdir(oldRun, { recursive: true });
    await writeFile(path.join(oldRun, "log"), "still running");
    await age(oldRun, Date.now() - 8 * 24 * 60 * 60 * 1000);
    const lock = await open(path.join(state, "active.lock"), "wx");
    try {
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/actions-runner.mjs"), "run", "--state-dir", state],
        { encoding: "utf8" }
      );

      expect(result.status).not.toBe(0);
      await expect(access(oldRun)).resolves.toBeUndefined();
    } finally {
      await lock.close();
    }
  });
});
