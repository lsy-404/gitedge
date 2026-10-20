import { DurableObject } from "cloudflare:workers";
import {
  GitTransferPlanSchema,
  GitTransferRequestSchema,
  GitTransferResultSchema,
  type GitTransferPlan,
  type GitTransferResult,
} from "../../../packages/contracts/src/github-sync";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited, readTextLimited } from "../../../src/worker/common/readText";
import { GIT_TRANSFER_PROGRAM } from "./git-transfer-program";

function publicPlan(plan: GitTransferPlan) {
  return { ...plan, source: { url: plan.source.url }, destination: { url: plan.destination.url } };
}
interface StoredTransfer {
  state: "preparing" | "prepared" | "pushing";
  plan: ReturnType<typeof publicPlan>;
}

export class GitTransfer extends DurableObject {
  async prepare(raw: GitTransferPlan): Promise<GitTransferResult> {
    const plan = GitTransferPlanSchema.parse(raw);
    if (await this.ctx.storage.get("transfer")) throw new Error("Transfer already exists.");
    await this.ctx.storage.put("transfer", { state: "preparing", plan: publicPlan(plan) });
    await this.ctx.storage.setAlarm(Date.now() + 120_000);
    const container = this.ctx.container;
    if (!container) throw new Error("Git transfer container is unavailable.");
    try {
      container.start({
        image: container.images.runtime,
        instance: "lite",
        enableInternet: true,
        entrypoint: ["sleep", "infinity"],
      });
      await container.setInactivityTimeout(120_000);
      const result = await this.execute("prepare", plan, 60_000);
      if (result.status === "ready")
        await this.ctx.storage.put("transfer", { state: "prepared", plan: publicPlan(plan) });
      else await this.cleanup();
      return result;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async push(raw: GitTransferPlan): Promise<GitTransferResult> {
    const plan = GitTransferPlanSchema.parse(raw);
    const stored = await this.ctx.storage.get<StoredTransfer>("transfer");
    if (
      stored?.state !== "prepared" ||
      JSON.stringify(stored.plan) !== JSON.stringify(publicPlan(plan))
    )
      throw new Error("Prepared Git transfer does not match.");
    await this.ctx.storage.put("transfer", { ...stored, state: "pushing" });
    try {
      return await this.execute("push", plan, 30_000);
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy("Git transfer finished");
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.cleanup();
  }

  private async execute(
    operation: "prepare" | "push",
    plan: GitTransferPlan,
    timeoutMs: number
  ): Promise<GitTransferResult> {
    if (!this.ctx.container?.running) throw new Error("Git transfer container is not running.");
    const process = await this.ctx.container.exec(["node", "-e", GIT_TRANSFER_PROGRAM], {
      cwd: "/workspace",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const output = process.stdout ? readTextLimited(process.stdout, 4096) : Promise.resolve("");
    const errors = process.stderr ? readTextLimited(process.stderr, 4096) : Promise.resolve("");
    const writer = process.stdin?.getWriter();
    if (!writer) throw new Error("Git transfer input is unavailable.");
    await writer.write(new TextEncoder().encode(JSON.stringify({ operation, plan })));
    await writer.close();
    const [stdout, , code] = await Promise.all([output, errors, process.exitCode]);
    if (code !== 0 || stdout === null) throw new Error("Git transfer process failed.");
    return GitTransferResultSchema.parse(JSON.parse(stdout));
  }
}

interface TransferEnvironment {
  GIT_TRANSFERS: DurableObjectNamespace<GitTransfer>;
}

export async function handleGitTransfer(
  request: Request,
  env: TransferEnvironment
): Promise<Response> {
  if (new URL(request.url).hostname !== "actions.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const parsed = GitTransferRequestSchema.safeParse(await readJsonLimited(request, 16_384));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid Git transfer.");
  const input = parsed.data;
  const stub = env.GIT_TRANSFERS.getByName(input.id);
  if (input.operation === "cleanup") {
    await stub.cleanup();
    return dataResponse({ cleaned: true });
  }
  const result =
    input.operation === "prepare" ? await stub.prepare(input.plan) : await stub.push(input.plan);
  return result.status === "failed"
    ? errorResponse(503, "git_transfer_failed", "Native Git transfer failed.")
    : dataResponse(result);
}
