import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
const { stdout } = await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD"]);
assert.match(stdout.trim(), /^[a-f0-9]{40}$/);
console.log(`Runner verified: ${process.platform}/${process.arch}, Node ${process.version}`);
console.log(`Checked out commit: ${stdout.trim()}`);
