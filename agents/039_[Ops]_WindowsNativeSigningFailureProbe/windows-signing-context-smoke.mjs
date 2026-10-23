import { execFileSync } from 'node:child_process';
import { mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const safeCodes = new Set(['INSECURE_CONTEXT_FILE', 'INVALID_CONTEXT', 'INVALID_CONTEXT_FILE']);
const runnerRoot = String.raw`D:\GitEdge\runner-broker-2`;
let result = { pass: false, code: 'UNEXPECTED', powershellExitCode: -1, nlink: 0, symlink: false, size: 0 };
let temporaryDirectory;

try {
  const contextModule = await import(pathToFileURL(path.join(runnerRoot, 'scripts', 'signing', 'context.mjs')));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gitedge-context-smoke-'));
  const contextFile = path.join(temporaryDirectory, 'context.json');
  const dummy = {
    schemaVersion: 1,
    baseUrl: 'https://gitedge.voidcarve.com/api/actions',
    ownerId: '00000000-0000-4000-8000-000000000001',
    repositoryId: '00000000-0000-4000-8000-000000000002',
    runnerId: '00000000-0000-4000-8000-000000000003',
    runId: '00000000-0000-4000-8000-000000000004',
    requestId: '00000000-0000-4000-8000-000000000005',
    platform: 'windows',
    workflowOid: 'a'.repeat(40),
    profileRevision: 'b'.repeat(40),
    generation: 1,
    nonce: 'c'.repeat(43),
    leaseToken: 'd'.repeat(64),
    leaseExpiresAt: Date.now() + 60 * 60 * 1000,
    jobToken: `ge_job_${'e'.repeat(64)}`,
  };
  await writeFile(contextFile, JSON.stringify(dummy), { flag: 'wx' });
  let powershellExitCode = 0;
  const aclScript = path.join(runnerRoot, 'scripts', 'secure-runner-context.ps1');
  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', aclScript,
      '-Path', contextFile,
    ], { windowsHide: true, stdio: 'ignore' });
  } catch (error) {
    powershellExitCode = Number.isInteger(error?.status) ? error.status : -1;
  }
  const metadata = await lstat(contextFile);
  let code = null;
  try {
    await contextModule.readSigningContext(contextFile, { platform: 'win32' });
  } catch (error) {
    code = safeCodes.has(error?.code) ? error.code : 'UNEXPECTED';
  }
  result = {
    pass: code === null && powershellExitCode === 0,
    code,
    powershellExitCode,
    nlink: metadata.nlink,
    symlink: metadata.isSymbolicLink(),
    size: metadata.size,
  };
} catch {
  result = { ...result, code: result.code === 'UNEXPECTED' ? 'UNEXPECTED' : result.code };
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify(result));
