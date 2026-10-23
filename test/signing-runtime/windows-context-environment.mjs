import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readSigningContext } from "../../scripts/signing/context.mjs";
import { windowsPowerShellEnvironment } from "../../scripts/signing/windows-process.mjs";

const execFileAsync = promisify(execFile);
const [contextFile, checkerScript] = process.argv.slice(2);
assert.ok(contextFile && checkerScript, "Expected context and ACL checker paths.");
const mixedCaseEnvironment = windowsPowerShellEnvironment({
  pSmOdUlEpAtH: "polluted",
  KEEP: "value",
});
assert.deepEqual(mixedCaseEnvironment, { KEEP: "value" });
assert.ok(Object.keys(process.env).some((name) => name.toLowerCase() === "psmodulepath"));
assert.equal(process.env.GE_CHILD_MARKER, "preserved");

await execFileAsync(
  "powershell.exe",
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", checkerScript, "-Path", contextFile],
  { windowsHide: true, env: windowsPowerShellEnvironment() }
);
const context = await readSigningContext(contextFile, { platform: "win32" });
assert.equal(context.platform, "windows");

const childEnvironment = windowsPowerShellEnvironment();
assert.ok(Object.keys(process.env).some((name) => name.toLowerCase() === "psmodulepath"));
assert.ok(!Object.keys(childEnvironment).some((name) => name.toLowerCase() === "psmodulepath"));
await execFileAsync(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "if ($env:GE_CHILD_MARKER -ne 'preserved' -or $env:PSModulePath -like '*synthetic*') { exit 9 }; Get-Command Get-Acl | Out-Null",
  ],
  { windowsHide: true, env: childEnvironment }
);

await assert.rejects(
  readSigningContext(path.join(path.dirname(contextFile), "inherited.json"), { platform: "win32" }),
  (error) => error.code === "INVALID_CONTEXT_FILE"
);
await assert.rejects(
  readSigningContext(path.join(path.dirname(contextFile), "extra-sid.json"), { platform: "win32" }),
  (error) => error.code === "INVALID_CONTEXT_FILE"
);
console.log("Windows PowerShell child environment and ACL path passed.");
