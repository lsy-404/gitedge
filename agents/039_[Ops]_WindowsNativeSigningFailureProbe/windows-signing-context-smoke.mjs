import { execFileSync } from 'node:child_process';
import { mkdtemp, lstat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runnerRoot = String.raw`D:\GitEdge\runner-broker-2`;
const secureHelper = path.join(runnerRoot, 'scripts', 'secure-runner-context.ps1');
const readerHelper = path.join(runnerRoot, 'scripts', 'signing', 'check-context-acl.ps1');
const contextModulePath = path.join(runnerRoot, 'scripts', 'signing', 'context.mjs');
const safeCodes = new Set(['INSECURE_CONTEXT_FILE', 'INVALID_CONTEXT', 'INVALID_CONTEXT_FILE']);
const safeCategories = new Set(['CommandNotFound', 'SecurityError', 'ParserError', 'PermissionDenied', 'InvalidArgument', 'ObjectNotFound']);

function summarizeFailure(error) {
  const text = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr ?? '');
  const missingCmdlet = /The term ['"](Get-Acl|Set-Acl)['"] is not recognized/i.exec(text)?.[1] ?? null;
  const category = [...safeCategories].find((name) => text.includes(name)) ?? (text ? 'Other' : null);
  return {
    exitCode: Number.isInteger(error?.status) ? error.status : -1,
    stderrCategory: category,
    missingCmdlet,
  };
}

function runHelper(script, contextFile, env) {
  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
      '-Path', contextFile,
    ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exitCode: 0, stderrCategory: null, missingCmdlet: null };
  } catch (error) {
    return summarizeFailure(error);
  }
}

async function readWithEnvironment(contextModule, contextFile, removeModulePath) {
  const removed = [];
  if (removeModulePath) {
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === 'psmodulepath') {
        removed.push([key, process.env[key]]);
        delete process.env[key];
      }
    }
  }
  try {
    await contextModule.readSigningContext(contextFile, { platform: 'win32' });
    return null;
  } catch (error) {
    return safeCodes.has(error?.code) ? error.code : 'UNEXPECTED';
  } finally {
    for (const [key, value] of removed) process.env[key] = value;
  }
}

let result = { pass: false, baseline: null, withoutPSModulePath: null, nlink: 0, symlink: false, size: 0 };
let temporaryDirectory;
try {
  const contextModule = await import(pathToFileURL(contextModulePath));
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
  const metadata = await lstat(contextFile);
  const baselineEnv = { ...process.env };
  const withoutPSModulePathEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
  );
  const baseline = {
    secureHelper: runHelper(secureHelper, contextFile, baselineEnv),
    readerHelper: runHelper(readerHelper, contextFile, baselineEnv),
    readerCode: await readWithEnvironment(contextModule, contextFile, false),
  };
  const withoutPSModulePath = {
    secureHelper: runHelper(secureHelper, contextFile, withoutPSModulePathEnv),
    readerHelper: runHelper(readerHelper, contextFile, withoutPSModulePathEnv),
    readerCode: await readWithEnvironment(contextModule, contextFile, true),
  };
  result = {
    pass: withoutPSModulePath.secureHelper.exitCode === 0 &&
      withoutPSModulePath.readerHelper.exitCode === 0 &&
      withoutPSModulePath.readerCode === null,
    baseline,
    withoutPSModulePath,
    nlink: metadata.nlink,
    symlink: metadata.isSymbolicLink(),
    size: metadata.size,
  };
} catch {
  result = { ...result, failure: 'UNEXPECTED' };
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify(result));
