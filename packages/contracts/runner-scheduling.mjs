const DEFAULT_MEMORY_MB = 512;
const MAX_MEMORY_MB = 1_048_576;
const MAX_CPUS = 512;
const MAX_DISK_MB = 1_048_576_000;
const MAX_MINUTES = 360;
const TOOL_NAME = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
export const RESOURCE_LABEL_PREFIXES = Object.freeze([
  "need-",
  "ram-",
  "cpu-",
  "disk-",
  "gpu-",
  "vram-",
]);

function invalidClaim(labels, minutes) {
  return {
    labels,
    memMb: DEFAULT_MEMORY_MB,
    cpus: 1,
    diskMb: 0,
    gpuVendor: null,
    vramMb: 0,
    tools: [],
    minutes,
    valid: false,
  };
}

export function hasNeedLabels(labels) {
  return (
    Array.isArray(labels) &&
    labels.some((label) => typeof label === "string" && isResourceLabel(label))
  );
}

export function isResourceLabel(label) {
  return (
    typeof label === "string" &&
    RESOURCE_LABEL_PREFIXES.some((prefix) => label.toLowerCase().startsWith(prefix))
  );
}

export function parseJobClaim(labels, defaultMinutes = 360) {
  if (
    !Array.isArray(labels) ||
    !Number.isInteger(defaultMinutes) ||
    defaultMinutes < 1 ||
    defaultMinutes > MAX_MINUTES ||
    !labels.every((label) => typeof label === "string" && label.length > 0 && label.length <= 100)
  )
    return invalidClaim([], 360);

  let memMb = 0;
  let cpus = 1;
  let diskMb = 0;
  let gpuVendor = null;
  let vramMb = 0;
  let minutes = defaultMinutes;
  let declaredMinutes = 0;
  let valid = true;
  const tools = new Set();
  const ordinary = [];

  for (const label of labels) {
    const lower = label.toLowerCase();
    if (!isResourceLabel(lower)) {
      ordinary.push(lower);
      continue;
    }

    let match = /^(?:need-mem|ram)-(\d+)(g|m)$/.exec(lower);
    if (match) {
      const value = Number(match[1]) * (match[2] === "g" ? 1024 : 1);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MEMORY_MB) valid = false;
      else memMb = Math.max(memMb, value);
      continue;
    }

    match = /^(?:need-cpu|cpu)-(\d+)$/.exec(lower);
    if (match) {
      const value = Number(match[1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CPUS) valid = false;
      else cpus = Math.max(cpus, value);
      continue;
    }

    match = /^(?:need-disk-(\d+)(g)|disk-(\d+)(g|m))$/.exec(lower);
    if (match) {
      const value = Number(match[1] ?? match[3]) * ((match[2] ?? match[4]) === "g" ? 1024 : 1);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DISK_MB) valid = false;
      else diskMb = Math.max(diskMb, value);
      continue;
    }

    match = /^gpu-(nvidia|amd|intel|apple)$/.exec(lower);
    if (match) {
      if (gpuVendor !== null && gpuVendor !== match[1]) valid = false;
      else gpuVendor = match[1];
      continue;
    }

    match = /^vram-(\d+)(g|m)$/.exec(lower);
    if (match) {
      const value = Number(match[1]) * (match[2] === "g" ? 1024 : 1);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MEMORY_MB) valid = false;
      else vramMb = Math.max(vramMb, value);
      continue;
    }

    match = /^need-tool-(.+)$/.exec(lower);
    if (match && TOOL_NAME.test(match[1])) {
      tools.add(match[1]);
      continue;
    }

    match = /^need-time-(\d+)m$/.exec(lower);
    if (match) {
      const value = Number(match[1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MINUTES) valid = false;
      else declaredMinutes = Math.max(declaredMinutes, value);
      continue;
    }

    valid = false;
  }

  return {
    labels: [...new Set(ordinary)],
    memMb: memMb || DEFAULT_MEMORY_MB,
    cpus,
    diskMb,
    gpuVendor,
    vramMb,
    tools: [...tools],
    minutes: declaredMinutes || minutes,
    valid,
  };
}

function matchesGpu(capacity, claim) {
  if (claim.gpuVendor === null && claim.vramMb === 0) return true;
  return (capacity.gpus ?? []).some(
    (gpu) =>
      (claim.gpuVendor === null || gpu.vendor === claim.gpuVendor) &&
      (claim.vramMb === 0 || (gpu.vramMb !== null && gpu.vramMb >= claim.vramMb))
  );
}

export function matchesLabels(required, available) {
  if (!Array.isArray(required) || !Array.isArray(available)) return false;
  const labels = new Set(available.map((label) => String(label).toLowerCase()));
  return required.every((label) => labels.has(String(label).toLowerCase()));
}

export function matchesCapacity(capacity, claim, options = {}) {
  const { allowUnknownLegacy = false, explicitNeeds = true } = options;
  if (!claim?.valid) return false;
  if (!capacity) return allowUnknownLegacy && !explicitNeeds;
  if (
    capacity.memFreeMb < claim.memMb ||
    capacity.cpus < claim.cpus ||
    capacity.diskFreeMb < claim.diskMb
  )
    return false;
  if (!matchesGpu(capacity, claim)) return false;
  const tools = new Set(capacity.tools.map((tool) => tool.toLowerCase()));
  if (claim.tools.some((tool) => !tools.has(tool))) return false;
  return capacity.load1 === null || capacity.load1 / capacity.cpus <= 1.5;
}

export function eligibilityReasons(capacity, budget, usedMinutes24h, claim, options = {}) {
  const { allowUnknownLegacy = false, explicitNeeds = true } = options;
  const reasons = [];
  if (!claim?.valid) return ["claim-invalid"];
  if (!capacity) {
    if (!(allowUnknownLegacy && !explicitNeeds)) reasons.push("capacity-unknown");
  } else {
    if (capacity.memFreeMb < claim.memMb) reasons.push("mem");
    if (capacity.cpus < claim.cpus) reasons.push("cpu");
    if (capacity.diskFreeMb < claim.diskMb) reasons.push("disk");
    if (!matchesGpu(capacity, claim)) reasons.push("gpu");
    const tools = new Set(capacity.tools.map((tool) => tool.toLowerCase()));
    for (const tool of claim.tools) if (!tools.has(tool)) reasons.push(`tool:${tool}`);
    if (capacity.load1 !== null && capacity.load1 / capacity.cpus > 1.5) reasons.push("load");
  }
  if (budget?.maxJobMinutes !== undefined && claim.minutes > budget.maxJobMinutes)
    reasons.push("budget-job");
  if (budget?.dailyMinutes !== undefined && usedMinutes24h + claim.minutes > budget.dailyMinutes)
    reasons.push("budget-daily");
  return reasons;
}

export function scoreRunner(capacity, budget, usedMinutes24h, claim) {
  if (!capacity || !claim?.valid || !matchesCapacity(capacity, claim))
    return Number.POSITIVE_INFINITY;
  const memSurplus = (capacity.memFreeMb - claim.memMb) / capacity.memTotalMb;
  const cpuSurplus = (capacity.cpus - claim.cpus) / capacity.cpus;
  const loadRatio = Math.min((capacity.load1 ?? 0) / capacity.cpus, 1.5) / 1.5;
  const budgetUsedRatio = budget?.dailyMinutes ? usedMinutes24h / budget.dailyMinutes : 0;
  return (
    40 * memSurplus +
    25 * cpuSurplus +
    20 * loadRatio +
    10 * budgetUsedRatio +
    (budget?.cost ?? 0) / 10
  );
}
