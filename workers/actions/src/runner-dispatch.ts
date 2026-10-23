import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  RunnerBudgetSchema,
  RunnerCapacitySchema,
  RUNNER_CAPACITY_STALE_MS,
  RUNNER_DECLINE_HOLD_MS,
  RUNNER_DISPATCH_FRAME_BYTES,
  RUNNER_DISPATCH_FRAME_LIMIT,
  RUNNER_DISPATCH_FRAME_WINDOW_MS,
  RUNNER_DISPATCH_MAX_RUNNERS,
  RUNNER_OFFER_TIMEOUT_MS,
  type RunnerBudget,
  type RunnerCapacity,
  type RunnerJobKind,
} from "../../../packages/contracts/src/runners";
import { scoreRunner } from "../../../packages/contracts/runner-scheduling.mjs";
import { createLogger } from "../../../src/worker/common/logger";
import {
  claimSpecificCandidate,
  ownsScope,
  releaseUndeliveredClaim,
  runnersSelect,
  storeRunnerReport,
  touchRunnerPresence,
  type ClaimOutcome,
  type ClaimedJob,
  type RunnerEnv,
  type RunnerRow,
} from "./runners";
import {
  evaluateRunnerCandidate,
  listRunnerCandidates,
  loadRunnerCandidate,
  readRunnerBudget,
  readRunnerCapacity,
  runnerUsageMinutes24h,
  type RunnerCandidate,
} from "./runner-scheduler";

const CLOSE_UNAUTHORIZED = 4001;
const CLOSE_PROTOCOL = 4002;
const CLOSE_SUPERSEDED = 4003;
// Upper bound for an accepted offer to finish its guarded claim before it is reaped.
const CLAIM_HOLD_MS = 60_000;
// Broker decline reasons that mean its execution slot is occupied, not that the job is unsuitable.
const SLOT_DECLINES = new Set(["busy", "slot-busy"]);

const SocketStateSchema = z.object({
  runnerId: z.string(),
  ready: z.boolean(),
  busy: z.boolean(),
  reportedAt: z.number(),
  windowStart: z.number(),
  frames: z.number(),
});
type SocketState = z.infer<typeof SocketStateSchema>;

const InboundFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("report"),
      capacity: RunnerCapacitySchema,
      budget: RunnerBudgetSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("accept"), offerId: z.string().min(1).max(64) }).strict(),
  z
    .object({
      type: z.literal("decline"),
      offerId: z.string().min(1).max(64),
      reason: z.string().max(200),
    })
    .strict(),
]);

type OutboundFrame =
  | { type: "ready"; runnerLabels: string[] }
  | {
      type: "offer";
      offerId: string;
      kind: RunnerJobKind;
      jobId: string;
      labels: string[];
      expiresAt: number;
    }
  | { type: "assign"; offerId: string; claim: ClaimedJob }
  | { type: "withdraw"; offerId: string; reason: string }
  | { type: "error"; code: string; message: string };

interface OfferRow extends Record<string, SqlStorageValue> {
  offer_id: string;
  job_kind: RunnerJobKind;
  job_id: string;
  runner_id: string;
  expires_at: number;
}

interface IdleRunner {
  row: RunnerRow;
  capacity: RunnerCapacity;
  budget: RunnerBudget | null;
  used: number;
}

export interface RunnerDispatchBinding {
  readonly RUNNER_DISPATCH?: DurableObjectNamespace<RunnerDispatch>;
  readonly LOG_LEVEL?: string;
}

export async function notifyRunnerDispatch(
  env: RunnerDispatchBinding,
  namespaceId: string
): Promise<void> {
  if (!env.RUNNER_DISPATCH) return;
  try {
    await env.RUNNER_DISPATCH.get(env.RUNNER_DISPATCH.idFromName(namespaceId)).notify();
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "runner-dispatch" }).warn(
      "runner-dispatch:notify-failed",
      {
        namespaceId,
        reason: cause instanceof Error ? cause.message : "unknown",
      }
    );
  }
}

// Reconciles lost notifications, expiry-freed runners and requeues; not a polling path for brokers.
export async function kickRunnerDispatch(env: RunnerEnv): Promise<void> {
  if (!env.RUNNER_DISPATCH) return;
  const namespaces = await env.DB.prepare(
    `SELECT namespace_id, MIN(created_at) AS oldest FROM (
      SELECT p.namespace_id, a.created_at FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
        JOIN repositories p ON p.id=a.repository_id
        WHERE j.status='queued' AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_runner_enabled=1
      UNION ALL
      SELECT p.namespace_id, j.created_at FROM actions_github_runner_jobs j
        JOIN forge_github_connections c ON c.id=j.connection_id JOIN repositories p ON p.id=c.repository_id
        WHERE j.status='queued' AND c.enabled=1 AND c.runner_enabled=1 AND p.deleted_at IS NULL AND p.archived=0
    ) GROUP BY namespace_id ORDER BY oldest, namespace_id LIMIT ?`
  )
    .bind(RUNNER_DISPATCH_MAX_RUNNERS * 2)
    .all<{ namespace_id: string }>();
  for (const row of namespaces.results) await notifyRunnerDispatch(env, row.namespace_id);
}

export class RunnerDispatch extends DurableObject<RunnerEnv> {
  private passing = false;
  private rerun = false;
  // Runners whose accepted offer is being committed; their reports must not move the claim snapshot.
  private readonly committing = new Set<string>();
  private rotation = 0;

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS offers (
        offer_id TEXT PRIMARY KEY,
        job_kind TEXT NOT NULL,
        job_id TEXT NOT NULL,
        runner_id TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS offers_job ON offers(job_kind, job_id);
      CREATE TABLE IF NOT EXISTS declines (
        job_kind TEXT NOT NULL,
        job_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        until INTEGER NOT NULL,
        PRIMARY KEY (job_kind, job_id, runner_id)
      );
    `);
  }

  private get logger() {
    return createLogger(this.env.LOG_LEVEL, { service: "runner-dispatch" });
  }

  async fetch(request: Request): Promise<Response> {
    const runnerId = request.headers.get("X-Runner-Id");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !runnerId)
      return new Response("Expected a runner WebSocket upgrade.", { status: 400 });
    for (const previous of this.openSockets(runnerId))
      previous.close(CLOSE_SUPERSEDED, "superseded");
    this.ctx.storage.sql.exec("DELETE FROM offers WHERE runner_id=?", runnerId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [runnerId]);
    server.serializeAttachment({
      runnerId,
      ready: false,
      busy: false,
      reportedAt: 0,
      windowStart: Date.now(),
      frames: 0,
    } satisfies SocketState);
    this.logger.info("runner-dispatch:connected", { runnerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async notify(): Promise<void> {
    await this.dispatch();
  }

  async disconnect(runnerId: string): Promise<void> {
    await this.revokeRunner(runnerId);
    await this.dispatch();
  }

  async alarm(): Promise<void> {
    await this.dispatch();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const current = this.socketState(ws);
    if (!current) return this.violation(ws, "state-missing");
    const now = Date.now();
    const state: SocketState =
      now - current.windowStart >= RUNNER_DISPATCH_FRAME_WINDOW_MS
        ? { ...current, windowStart: now, frames: 1 }
        : { ...current, frames: current.frames + 1 };
    if (state.frames > RUNNER_DISPATCH_FRAME_LIMIT)
      return this.violation(ws, "rate-limited", state.runnerId);
    ws.serializeAttachment(state);
    if (
      typeof message !== "string" ||
      message.length > RUNNER_DISPATCH_FRAME_BYTES ||
      new TextEncoder().encode(message).byteLength > RUNNER_DISPATCH_FRAME_BYTES
    )
      return this.violation(ws, "frame-invalid", state.runnerId);
    let frame: z.infer<typeof InboundFrameSchema>;
    try {
      const parsed = InboundFrameSchema.safeParse(JSON.parse(message));
      if (!parsed.success) return this.violation(ws, "frame-invalid", state.runnerId);
      frame = parsed.data;
    } catch {
      return this.violation(ws, "frame-invalid", state.runnerId);
    }
    if (!state.ready && frame.type !== "report")
      return this.violation(ws, "report-required", state.runnerId);
    if (frame.type === "report") await this.handleReport(ws, state, frame);
    else if (frame.type === "accept") await this.handleAccept(ws, state, frame.offerId);
    else await this.handleDecline(ws, state, frame.offerId, frame.reason);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = this.socketState(ws);
    if (state) await this.socketGone(state.runnerId);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const state = this.socketState(ws);
    this.logger.warn("runner-dispatch:socket-error", {
      runnerId: state?.runnerId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    if (state) await this.socketGone(state.runnerId);
  }

  private socketState(ws: WebSocket): SocketState | null {
    const parsed = SocketStateSchema.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }

  // Re-reads the attachment so concurrent handlers do not overwrite each other's fields.
  private updateState(ws: WebSocket, patch: Partial<Omit<SocketState, "runnerId">>): void {
    const current = this.socketState(ws);
    if (current) ws.serializeAttachment({ ...current, ...patch } satisfies SocketState);
  }

  private openSockets(runnerId?: string): WebSocket[] {
    return this.ctx
      .getWebSockets(runnerId)
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private send(ws: WebSocket, frame: OutboundFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private trySend(ws: WebSocket, frame: OutboundFrame): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.send(ws, frame);
      return true;
    } catch {
      return false;
    }
  }

  private sendToRunner(runnerId: string, frame: OutboundFrame): boolean {
    const target = this.openSockets(runnerId).find((socket) => this.socketState(socket)?.ready);
    return target ? this.trySend(target, frame) : false;
  }

  private async violation(ws: WebSocket, code: string, runnerId?: string): Promise<void> {
    this.logger.warn("runner-dispatch:protocol-violation", { runnerId, code });
    try {
      this.send(ws, { type: "error", code, message: "Protocol violation." });
      ws.close(CLOSE_PROTOCOL, code);
    } catch {
      // The socket is already gone.
    }
    if (runnerId) await this.socketGone(runnerId);
  }

  // Applies the same authorization as the connect handshake; a runner that fails it is disconnected.
  private async loadRunner(runnerId: string): Promise<RunnerRow | null> {
    const row = await this.env.DB.prepare(
      `${runnersSelect} JOIN users u ON u.id = r.created_by
       WHERE r.id=? AND r.revoked_at IS NULL AND u.disabled_at IS NULL
       AND (r.repository_id IS NULL OR (p.deleted_at IS NULL AND p.namespace_id = r.namespace_id))`
    )
      .bind(runnerId)
      .first<RunnerRow>();
    if (row && (await ownsScope(this.env, row.created_by, row.namespace_id, row.repository_id)))
      return row;
    this.logger.warn("runner-dispatch:runner-unauthorized", { runnerId });
    await this.revokeRunner(runnerId);
    return null;
  }

  private async revokeRunner(runnerId: string): Promise<void> {
    for (const socket of this.openSockets(runnerId)) socket.close(CLOSE_UNAUTHORIZED, "revoked");
    this.ctx.storage.sql.exec("DELETE FROM offers WHERE runner_id=?", runnerId);
    await this.env.DB.prepare("UPDATE actions_runners SET connected=0 WHERE id=?")
      .bind(runnerId)
      .run();
  }

  private async handleReport(
    ws: WebSocket,
    state: SocketState,
    frame: Extract<z.infer<typeof InboundFrameSchema>, { type: "report" }>
  ): Promise<void> {
    const now = Date.now();
    const runner = await this.loadRunner(state.runnerId);
    if (!runner) return this.dispatch();
    if (this.committing.has(runner.id)) await touchRunnerPresence(this.env, runner.id, now);
    else await storeRunnerReport(this.env, runner, frame.capacity, frame.budget ?? null, now);
    const busy = frame.capacity.busy === 1;
    this.updateState(ws, { ready: true, busy, reportedAt: now });
    if (!state.ready)
      this.send(ws, {
        type: "ready",
        runnerLabels: z.array(z.string()).parse(JSON.parse(runner.labels_json)),
      });
    if (!state.ready || (state.busy && !busy) || state.reportedAt < now - RUNNER_CAPACITY_STALE_MS)
      await this.dispatch();
  }

  private async handleAccept(ws: WebSocket, state: SocketState, offerId: string): Promise<void> {
    const offer = this.findOffer(offerId, state.runnerId);
    if (!offer) {
      this.send(ws, { type: "withdraw", offerId, reason: "unknown-offer" });
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE offers SET expires_at=? WHERE offer_id=?",
      Date.now() + CLAIM_HOLD_MS,
      offerId
    );
    let outcome: ClaimOutcome;
    this.committing.add(offer.runner_id);
    try {
      outcome = await this.commitOffer(offer);
    } catch (cause) {
      this.logger.error("runner-dispatch:claim-failed", {
        runnerId: offer.runner_id,
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      outcome = { kind: "failed", reason: "claim-error" };
    } finally {
      this.committing.delete(offer.runner_id);
    }
    this.ctx.storage.sql.exec("DELETE FROM offers WHERE offer_id=?", offerId);
    if (outcome.kind === "claimed") await this.deliver(ws, offer, outcome.claim);
    else {
      this.holdDecline(offer, Date.now());
      this.trySend(ws, {
        type: "withdraw",
        offerId,
        reason: outcome.kind === "failed" ? outcome.reason : "unavailable",
      });
    }
    await this.dispatch();
  }

  // The assignment goes only to the socket that accepted; if it is gone the committed claim is undone.
  private async deliver(ws: WebSocket, offer: OfferRow, claim: ClaimedJob): Promise<void> {
    if (this.trySend(ws, { type: "assign", offerId: offer.offer_id, claim })) {
      this.updateState(ws, { busy: true });
      this.logger.info("runner-dispatch:assigned", {
        runnerId: offer.runner_id,
        kind: offer.job_kind,
        jobId: offer.job_id,
      });
      return;
    }
    let released = false;
    try {
      released = await releaseUndeliveredClaim(
        this.env,
        offer.job_kind,
        offer.job_id,
        claim.leaseToken
      );
    } catch (cause) {
      this.logger.error("runner-dispatch:assign-rollback-failed", {
        runnerId: offer.runner_id,
        jobId: offer.job_id,
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
    this.logger.warn("runner-dispatch:assign-undelivered", {
      runnerId: offer.runner_id,
      kind: offer.job_kind,
      jobId: offer.job_id,
      released,
    });
  }

  // Re-checks the offered job against fresh runner state; the guarded D1 update is the commit point.
  private async commitOffer(offer: OfferRow): Promise<ClaimOutcome> {
    const runner = await this.loadRunner(offer.runner_id);
    if (!runner) return { kind: "skipped" };
    const candidate = await loadRunnerCandidate(this.env, runner, offer.job_kind, offer.job_id);
    if (!candidate) return { kind: "skipped" };
    const now = Date.now();
    const evaluated = evaluateRunnerCandidate(
      runner,
      readRunnerCapacity(runner.capacity_json),
      readRunnerBudget(runner.budget_json),
      await runnerUsageMinutes24h(this.env, runner.id, now),
      candidate
    );
    if (evaluated.reasons.length) return { kind: "skipped" };
    return claimSpecificCandidate(this.env, runner, candidate, evaluated, now);
  }

  private async handleDecline(
    ws: WebSocket,
    state: SocketState,
    offerId: string,
    reason: string
  ): Promise<void> {
    const offer = this.findOffer(offerId, state.runnerId);
    if (!offer) return;
    this.ctx.storage.sql.exec("DELETE FROM offers WHERE offer_id=?", offerId);
    // An occupied slot excludes the runner until its next idle report instead of holding the job.
    if (SLOT_DECLINES.has(reason)) this.updateState(ws, { busy: true });
    else this.holdDecline(offer, Date.now());
    this.logger.info("runner-dispatch:offer-declined", {
      runnerId: offer.runner_id,
      jobId: offer.job_id,
      reason: reason.slice(0, 100),
    });
    await this.dispatch();
  }

  private findOffer(offerId: string, runnerId: string): OfferRow | null {
    const rows = this.ctx.storage.sql
      .exec<OfferRow>(
        "SELECT * FROM offers WHERE offer_id=? AND runner_id=? AND expires_at>?",
        offerId,
        runnerId,
        Date.now()
      )
      .toArray();
    return rows[0] ?? null;
  }

  private holdDecline(offer: OfferRow, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO declines (job_kind,job_id,runner_id,until) VALUES (?,?,?,?)",
      offer.job_kind,
      offer.job_id,
      offer.runner_id,
      now + RUNNER_DECLINE_HOLD_MS
    );
  }

  private async socketGone(runnerId: string): Promise<void> {
    if (this.openSockets(runnerId).length > 0) return;
    this.ctx.storage.sql.exec("DELETE FROM offers WHERE runner_id=?", runnerId);
    await this.env.DB.prepare("UPDATE actions_runners SET connected=0 WHERE id=?")
      .bind(runnerId)
      .run();
    this.logger.info("runner-dispatch:disconnected", { runnerId });
    await this.dispatch();
  }

  // Passes are serialized: a request arriving mid-pass marks a rerun instead of interleaving.
  private async dispatch(): Promise<void> {
    if (this.passing) {
      this.rerun = true;
      return;
    }
    this.passing = true;
    try {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun);
    } catch (cause) {
      this.logger.error("runner-dispatch:pass-failed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    } finally {
      this.passing = false;
    }
    await this.scheduleAlarm();
  }

  private async pass(): Promise<void> {
    const now = Date.now();
    this.expire(now);
    const idle = await this.idleRunners(now);
    if (idle.length) await this.offerJobs(idle, now);
  }

  private expire(now: number): void {
    const expired = this.ctx.storage.sql
      .exec<OfferRow>("SELECT * FROM offers WHERE expires_at<=?", now)
      .toArray();
    for (const offer of expired) {
      this.ctx.storage.sql.exec("DELETE FROM offers WHERE offer_id=?", offer.offer_id);
      this.holdDecline(offer, now);
      this.sendToRunner(offer.runner_id, {
        type: "withdraw",
        offerId: offer.offer_id,
        reason: "timeout",
      });
      this.logger.info("runner-dispatch:offer-expired", {
        runnerId: offer.runner_id,
        jobId: offer.job_id,
      });
    }
    this.ctx.storage.sql.exec("DELETE FROM declines WHERE until<=?", now);
  }

  private async idleRunners(now: number): Promise<IdleRunner[]> {
    const offered = new Set(
      this.ctx.storage.sql
        .exec<{ runner_id: string }>("SELECT runner_id FROM offers")
        .toArray()
        .map((row) => row.runner_id)
    );
    const ids = new Set<string>();
    for (const socket of this.openSockets()) {
      const state = this.socketState(socket);
      if (
        state?.ready &&
        !state.busy &&
        state.reportedAt >= now - RUNNER_CAPACITY_STALE_MS &&
        !offered.has(state.runnerId)
      )
        ids.add(state.runnerId);
    }
    // Stable order rotated across passes so a capped pass does not always favour the same runners.
    const ordered = [...ids].sort();
    const start = ordered.length ? this.rotation % ordered.length : 0;
    const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
    const idle: IdleRunner[] = [];
    let inspected = 0;
    for (const id of rotated) {
      if (idle.length >= RUNNER_DISPATCH_MAX_RUNNERS) break;
      inspected += 1;
      const row = await this.loadRunner(id);
      if (!row) continue;
      const capacity = readRunnerCapacity(row.capacity_json);
      if (
        !capacity ||
        capacity.busy === 1 ||
        (row.held_until !== null && row.held_until > now) ||
        row.capacity_reported_at === null ||
        row.capacity_reported_at < now - RUNNER_CAPACITY_STALE_MS
      )
        continue;
      const running = await this.env.DB.prepare(
        `SELECT 1 AS busy FROM actions_runner_runs WHERE runner_id=? AND status='running'
         UNION ALL SELECT 1 AS busy FROM actions_github_runner_jobs WHERE runner_id=? AND status='running' LIMIT 1`
      )
        .bind(id, id)
        .first();
      if (running) continue;
      idle.push({
        row,
        capacity,
        budget: readRunnerBudget(row.budget_json),
        used: await runnerUsageMinutes24h(this.env, id, now),
      });
    }
    this.rotation = start + inspected;
    if (inspected < rotated.length)
      this.logger.warn("runner-dispatch:runner-limit", {
        candidates: rotated.length,
        inspected,
      });
    return idle;
  }

  private async offerJobs(idle: IdleRunner[], now: number): Promise<void> {
    const candidates = new Map<string, RunnerCandidate>();
    for (const runner of idle)
      for (const candidate of await listRunnerCandidates(this.env, runner.row))
        candidates.set(`${candidate.kind}:${candidate.id}`, candidate);
    const offeredJobs = new Set(
      this.ctx.storage.sql
        .exec<{ job_kind: string; job_id: string }>("SELECT job_kind,job_id FROM offers")
        .toArray()
        .map((row) => `${row.job_kind}:${row.job_id}`)
    );
    const declined = new Set(
      this.ctx.storage.sql
        .exec<{ job_kind: string; job_id: string; runner_id: string }>(
          "SELECT job_kind,job_id,runner_id FROM declines WHERE until>?",
          now
        )
        .toArray()
        .map((row) => `${row.job_kind}:${row.job_id}:${row.runner_id}`)
    );
    const ordered = [...candidates.values()].sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)
    );
    const taken = new Set<string>();
    for (const candidate of ordered) {
      const key = `${candidate.kind}:${candidate.id}`;
      if (offeredJobs.has(key)) continue;
      let best: { runner: IdleRunner; labels: string[]; score: number } | null = null;
      for (const runner of idle) {
        if (taken.has(runner.row.id) || declined.has(`${key}:${runner.row.id}`)) continue;
        const evaluated = evaluateRunnerCandidate(
          runner.row,
          runner.capacity,
          runner.budget,
          runner.used,
          candidate
        );
        if (evaluated.reasons.length) continue;
        const score = scoreRunner(runner.capacity, runner.budget, runner.used, evaluated.claim);
        if (!best || score < best.score) best = { runner, labels: evaluated.labels, score };
      }
      if (!best) continue;
      this.offer(best.runner.row.id, candidate, best.labels, now);
      taken.add(best.runner.row.id);
    }
  }

  private offer(runnerId: string, candidate: RunnerCandidate, labels: string[], now: number): void {
    const offerId = crypto.randomUUID();
    const expiresAt = now + RUNNER_OFFER_TIMEOUT_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO offers (offer_id,job_kind,job_id,runner_id,expires_at) VALUES (?,?,?,?,?)",
      offerId,
      candidate.kind,
      candidate.id,
      runnerId,
      expiresAt
    );
    const sent = this.sendToRunner(runnerId, {
      type: "offer",
      offerId,
      kind: candidate.kind,
      jobId: candidate.id,
      labels,
      expiresAt,
    });
    if (!sent) {
      this.ctx.storage.sql.exec("DELETE FROM offers WHERE offer_id=?", offerId);
      this.logger.warn("runner-dispatch:offer-undelivered", { runnerId, jobId: candidate.id });
      return;
    }
    this.logger.info("runner-dispatch:offer-sent", {
      runnerId,
      kind: candidate.kind,
      jobId: candidate.id,
    });
  }

  private async scheduleAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(at) AS at FROM (SELECT expires_at AS at FROM offers UNION ALL SELECT until AS at FROM declines)`
      )
      .one().at;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }
}
