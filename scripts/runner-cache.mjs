import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createRunnerCacheServer } from "./runner-cache-protocol.mjs";

const configuration = z
  .object({
    version: z.literal(1),
    directory: z.string().min(1),
    maxBytes: z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER),
    address: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    profiles: z.array(z.string().min(1).max(64)).min(1).max(64),
    proxy: z.url().optional(),
  })
  .strict();

export async function loadRunnerCache(state, profiles) {
  const file = path.join(state, "cache.json");
  const info = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 16_384 ||
    (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
  )
    throw new Error("Cache configuration must be a private regular file.");
  const config = configuration.parse(JSON.parse(await readFile(file, "utf8")));
  if (
    !path.isAbsolute(config.directory) ||
    path.dirname(config.directory) === config.directory ||
    path.resolve(config.directory) === (await realpath(state))
  )
    throw new Error("Cache storage requires its own absolute directory.");
  if (new Set(config.profiles).size !== config.profiles.length)
    throw new Error("Cache profiles must be unique.");
  const selected = config.profiles.map((id) => {
    const profile = profiles.find((value) => value.id === id);
    if (!profile) throw new Error("Cache configuration names an unregistered profile.");
    if (
      profile.vm &&
      (profile.vm.machine.guestNetwork.gateway !== config.address ||
        profile.vm.machine.cachePort !== config.port)
    )
      throw new Error("VM cache access must match its private gateway and allowed cache port.");
    if (!profile.vm && config.address !== "127.0.0.1")
      throw new Error("Host runner cache must bind to loopback.");
    return profile;
  });
  if (config.proxy) {
    const proxy = new URL(config.proxy);
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    )
      throw new Error("Cache proxy must be an HTTP proxy origin without credentials.");
  }
  const { openRunnerCacheStore } = await import("./runner-cache-store.mjs");
  const store = await openRunnerCacheStore(config);
  let server;
  try {
    server = await createRunnerCacheServer({ store, ...config });
  } catch (error) {
    await store.close();
    throw error;
  }
  const enabled = new Set(selected.map((profile) => profile.id));
  return {
    capacity(profile) {
      return enabled.has(profile.id)
        ? { supported: true, ...store.stats(profile.runnerId) }
        : { supported: false };
    },
    createSession(profile, claim, address = "127.0.0.1") {
      if (!enabled.has(profile.id) || claim.run.kind === "signing") return undefined;
      const run = claim.run;
      if (
        run.kind === "github" &&
        (!Number.isSafeInteger(run.githubRepositoryId) || run.githubRepositoryId < 1)
      )
        throw new Error("The GitHub cache requires the claimed repository identity.");
      if (
        run.kind !== "github" &&
        (typeof run.ref !== "string" || !/^refs\/(heads|tags)\//.test(run.ref))
      )
        throw new Error("The cache requires a claimed repository ref.");
      return server.createSession({
        address,
        runner: profile.runnerId,
        repository:
          run.kind === "github"
            ? `github:${run.githubRepositoryId}`
            : `${profile.origin}/${run.repository}`,
        kind: run.kind === "github" ? "github" : "gitedge",
        ref: run.ref,
        githubRepositoryId: run.githubRepositoryId,
        expiresAt: Date.now() + run.timeoutMinutes * 60_000,
      });
    },
    async close() {
      await server.close();
      await store.close();
    },
  };
}

export async function patchRunnerCacheEnvironment(runner) {
  const file = path.join(runner, "bin", "Runner.Worker.dll");
  const source = await readFile(file);
  const original = Buffer.from("ACTIONS_RESULTS_URL", "utf16le");
  const replacement = Buffer.from("ACTIONS_RESULTS_ORL", "utf16le");
  let count = 0;
  let offset = source.indexOf(original);
  while (offset !== -1) {
    replacement.copy(source, offset);
    count++;
    offset = source.indexOf(original, offset + original.length);
  }
  if (count < 1 || count > 16)
    throw new Error("The official runner does not support the cache endpoint override.");
  await writeFile(file, source);
}

export function cacheEnvironment(url, endpoint) {
  const bypass = [
    ...new Set([
      ...(process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").filter(Boolean),
      "127.0.0.1",
      "localhost",
      "::1",
      ...(endpoint ? [new URL(endpoint).hostname] : []),
    ]),
  ].join(",");
  return {
    ACTIONS_RESULTS_URL: url,
    ACTIONS_CACHE_SERVICE_V2: "true",
    NO_PROXY: bypass,
    no_proxy: bypass,
  };
}
