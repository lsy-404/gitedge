import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTartVm,
  recoverTartVm,
  tartVmName,
  tartRunArguments,
  validateTartPool,
} from "../scripts/runner-vm/tart.mjs";
import { loadVmPools, vmSlot } from "../scripts/runner-vm.mjs";

const id = "aa32f7ec-3db9-44bf-894c-1234567890ab";
function pool() {
  return {
    slots: 1,
    addresses: ["127.0.0.1"],
    machine: {
      baseImage: "macmini-build-base",
      cpus: 4,
      memoryMiB: 8192,
      guestNetwork: { gateway: "127.0.0.1" },
      cachePort: 3129,
    },
    guest: { sshUser: "admin" },
  };
}

test("Tart configuration rejects remote bases, unsafe names, extra slots and exposed caches", () => {
  assert.doesNotThrow(() => validateTartPool(pool()));
  for (const value of ["../base", "ghcr.io/image:latest", tartVmName(id), "base\nflag"])
    assert.throws(() =>
      validateTartPool({
        ...pool(),
        machine: { ...pool().machine, baseImage: value },
      })
    );
  for (const slots of [0, 2, 1.5]) assert.throws(() => validateTartPool({ ...pool(), slots }));
  assert.throws(() => validateTartPool({ ...pool(), addresses: ["192.168.64.2"] }));
  assert.throws(() => validateTartPool({ ...pool(), guest: { sshUser: "root;bad" } }));
  assert.throws(() => tartVmName("../../base"));
});

test("Tart network policy exposes only incoming host SSH and no host filesystem or clipboard", () => {
  const args = tartRunArguments(tartVmName(id));
  assert(args.includes("--no-clipboard"));
  assert(args.includes("--net-softnet"));
  assert(args.includes("out @host,out @peers,in 0.0.0.0/0"));
  assert(
    args.includes(
      "in proto tcp @host port 22,out proto udp @host port 53,out proto tcp @host port 53"
    )
  );
  assert(!args.some((arg) => /--dir|--net-bridged|--net-host|--net-softnet-expose/.test(arg)));
});

test("registered Tart profiles fail closed when vm.json is absent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ge-tart-config-"));
  try {
    await assert.rejects(
      loadVmPools(directory, [{ execution: "tart" }]),
      /host execution is disabled/
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

const mac = process.platform === "darwin" && process.arch === "arm64";
test(
  "provider clones one VM, propagates exit status, rejects a second job and removes only its clone",
  { skip: !mac },
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ge-tart-lifecycle-")));
    const home = path.join(root, "tart"),
      directory = path.join(root, id),
      executable = path.join(root, "fake-tart");
    await mkdir(home, { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await symlink(process.execPath, path.join(root, "node"));
    const fake = `#!${path.join(root, "node")}
const fs=require('node:fs'),p=require('node:path');
const a=process.argv.slice(2),h=process.env.TART_HOME;
fs.appendFileSync(p.join(h,'calls'),JSON.stringify(a)+'\\n');
const vm=p.join(h,'vms',a[2]||a[1]);
if(a[0]==='list')process.stdout.write(JSON.stringify(fs.readdirSync(p.join(h,'vms')).map(Name=>({Name,Source:'local',Running:false,State:'stopped'}))));
if(a[0]==='clone')fs.mkdirSync(vm,{recursive:true});
if(a[0]==='delete')fs.rmSync(p.join(h,'vms',a[1]),{recursive:true});
if(a[0]==='run')setInterval(()=>{},1000);
if(a[0]==='exec'&&a.includes('/usr/bin/id')){process.stdout.write('admin\\n');process.exit(0);}
if(a[0]==='exec'){let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{if(s){const r=JSON.parse(s);process.stdout.write('guest output');process.exitCode=r.args[0]==='fail'?7:0;}});}
`;
    await writeFile(executable, fake, { mode: 0o700 });
    await mkdir(path.join(home, "vms", "macmini-build-base"), {
      recursive: true,
    });
    const config = {
      ...pool(),
      tart: executable,
      softnet: executable,
      tartHome: home,
      machine: {
        ...pool().machine,
        guestRoot: "/opt/gitedge/job",
        guestNode: "/usr/local/bin/node",
        guestAgent: "/opt/gitedge/scripts/runner-vm/guest.mjs",
      },
    };
    try {
      const vm = await createTartVm(
        config,
        { id, directory, signal: AbortSignal.timeout(15_000) },
        {
          openCacheTunnel: async () => ({ failure: () => undefined }),
        }
      );
      const task = await vm.start({
        command: "/bin/true",
        args: ["fail"],
        cwd: "/opt/gitedge/job",
        env: {},
        input: new Uint8Array(),
      });
      assert.equal((await task.done).code, 7);
      await assert.rejects(vm.start({}), /one job/);
      await vm.dispose();
      await vm.dispose();
      assert.deepEqual(await readdir(path.join(home, "vms")), ["macmini-build-base"]);
      const calls = (await readFile(path.join(home, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(calls.filter((call) => call[0] === "clone").length, 1);
      assert.equal(calls.filter((call) => call[0] === "delete").length, 1);
      await assert.rejects(recoverTartVm(config, { id: "../base", directory }), /run id/);
    } finally {
      await rm(root, { recursive: true });
    }
  }
);

test(
  "cancelled boot removes its partial clone while retaining the base image",
  { skip: !mac },
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ge-tart-cancel-")));
    const home = path.join(root, "tart"),
      directory = path.join(root, id),
      executable = path.join(root, "fake-tart");
    await mkdir(home, { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await mkdir(path.join(home, "vms", "macmini-build-base"), {
      recursive: true,
    });
    await symlink(process.execPath, path.join(root, "node"));
    await writeFile(
      executable,
      `#!${path.join(root, "node")}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),h=process.env.TART_HOME;
if(a[0]==='list')process.stdout.write(JSON.stringify(fs.readdirSync(p.join(h,'vms')).map(Name=>({Name,Source:'local',Running:false,State:'stopped'}))));
if(a[0]==='clone')fs.mkdirSync(p.join(h,'vms',a[2]));
if(a[0]==='run')setInterval(()=>{},1000);
if(a[0]==='exec')process.exitCode=1;
if(a[0]==='delete')fs.rmSync(p.join(h,'vms',a[1]),{recursive:true});
`,
      { mode: 0o700 }
    );
    const config = {
      ...pool(),
      tart: executable,
      softnet: executable,
      tartHome: home,
    };
    try {
      await assert.rejects(
        createTartVm(config, {
          id,
          directory,
          signal: AbortSignal.timeout(300),
        })
      );
      assert.deepEqual(await readdir(path.join(home, "vms")), ["macmini-build-base"]);
    } finally {
      await rm(root, { recursive: true });
    }
  }
);

test("Tart admission reports cached reclaimable memory instead of treating free pages as availability", () => {
  const config = {
    driver: "tart",
    slots: 1,
    machine: { memoryMiB: 24576, cpus: 8 },
    hostAvailableMemoryMiB: 32768,
  };
  const pool = { memoryBudgetMiB: 32768, cpuBudget: 10 };
  const slot = vmSlot(pool, config, { subscribe() {} }, { memory: 0, cpus: 0 });
  assert.equal(slot.busy(), 0);
  config.hostAvailableMemoryMiB = 16384;
  assert.equal(slot.busy(), 1);
});

test(
  "the first Tart capacity report refreshes host available memory before reporting busy",
  { skip: !mac },
  async () => {
    const { getVmCapacity } = await import("../scripts/runner-vm.mjs");
    const config = {
      driver: "tart",
      slots: 1,
      vmRoot: os.tmpdir(),
      guest: { platform: "macos", arch: "arm64" },
      machine: { memoryMiB: 24576, cpus: 8 },
      verified: { tools: ["node"], memFreeMb: 16000, diskFreeMb: 1000 },
    };
    const slot = vmSlot(
      { memoryBudgetMiB: 32768, cpuBudget: 10 },
      config,
      { subscribe() {} },
      { memory: 0, cpus: 0 }
    );
    const capacity = await getVmCapacity(config, slot);
    assert(Number.isFinite(config.hostAvailableMemoryMiB));
    assert.equal(capacity.busy, config.hostAvailableMemoryMiB >= 24576 ? 0 : 1);
  }
);
