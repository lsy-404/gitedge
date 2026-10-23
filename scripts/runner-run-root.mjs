import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const restrictedRoots = new Set();

// Windows MAX_PATH leaves little room for nested node_modules, so run directories sit at <drive>\ge\r.
export function runRootPath(state) {
  const resolved = path.resolve(state);
  return process.platform === "win32"
    ? path.join(path.parse(resolved).root, "ge", "r")
    : path.join(resolved, "runs");
}

export const RUN_DIRECTORY_PATTERN = /^[rs][A-Za-z0-9]{6}$/;

async function restrictToCurrentUser(directory) {
  if (restrictedRoots.has(directory)) return;
  const user = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${os.userInfo().username}`
    : os.userInfo().username;
  await execFileAsync("icacls", [directory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`]);
  restrictedRoots.add(directory);
}

export async function createRunDirectory(state, kind) {
  const root = runRootPath(state);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await restrictToCurrentUser(path.dirname(root));
  await chmod(root, 0o700);
  const directory = await mkdtemp(path.join(root, kind === "signing" ? "s" : "r"));
  await chmod(directory, 0o700);
  return directory;
}
