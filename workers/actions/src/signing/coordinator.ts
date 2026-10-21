import { DurableObject } from "cloudflare:workers";
import { SigningProfileSchema, SigningRequestSchema, SigningSubmissionSchema } from "../../../../packages/contracts/src/signing";
import type { SigningEnv, SigningExecutionHooks, SigningQueueInput, SigningStoredRequest } from "./types";

interface StoredRow {
  [key: string]: string | number | null;
  id: string;
  repository_id: string;
  owner_id: string;
  idempotency_key: string;
  profile_json: string;
  submission_json: string;
  state: string;
  current_stage: string;
  run_id: string | null;
  source_digest: string;
  source_size: number;
  output_digest: string | null;
  output_size: number | null;
  authorized_at: number;
  verification_json: string | null;
  generation: number;
  nonce: string;
  created_at: number;
  completed_at: number | null;
};

export class SigningCoordinator extends DurableObject<SigningEnv> {
  constructor(ctx: DurableObjectState, env: SigningEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS signing_requests (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        submission_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted','awaiting_source','queued','running','succeeded','failed','cancelled')),
        current_stage TEXT NOT NULL DEFAULT 'sign',
        run_id TEXT,
        source_digest TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        output_digest TEXT,
        output_size INTEGER,
        generation INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        authorized_at INTEGER NOT NULL DEFAULT 0,
        verification_json TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(repository_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS signing_requests_owner ON signing_requests(owner_id, repository_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS signing_uploads (
        request_id TEXT PRIMARY KEY REFERENCES signing_requests(id) ON DELETE CASCADE,
        upload_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        part_size INTEGER NOT NULL,
        part_count INTEGER NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS signing_upload_parts (
        request_id TEXT NOT NULL REFERENCES signing_uploads(request_id) ON DELETE CASCADE,
        part INTEGER NOT NULL,
        etag TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY(request_id,part)
      );
      CREATE TABLE IF NOT EXISTS signing_stage_outputs (
        request_id TEXT NOT NULL REFERENCES signing_requests(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        verification_json TEXT NOT NULL,
        PRIMARY KEY(request_id,stage)
      );
    `);
  }

  private row(id: string): StoredRow | null {
    return this.ctx.storage.sql.exec<StoredRow>("SELECT * FROM signing_requests WHERE id=?", id).toArray()[0] ?? null;
  }

  private public(row: StoredRow) {
    const input = SigningSubmissionSchema.parse(JSON.parse(row.submission_json));
    return SigningRequestSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      ownerId: row.owner_id,
      profile: input.profile,
      profileRevision: JSON.parse(row.profile_json).revision,
      platform: input.platform,
      stage: row.current_stage,
      runId: row.run_id,
      state: row.state,
      sourceDigest: row.source_digest,
      sourceSize: row.source_size,
      outputDigest: row.output_digest,
      outputSize: row.output_size,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    });
  }

  private dispatch(row: StoredRow) {
    const saved = JSON.parse(row.profile_json) as Record<string, unknown>;
    const operatorApproval = saved.operatorApproval as { operatorApproved: true; approvedBy: string; approvedAt: number };
    const profile = { ...saved };
    delete profile.operatorApproval;
    return {
      profile,
      submission: SigningSubmissionSchema.parse(JSON.parse(row.submission_json)),
      generation: row.generation,
      nonce: row.nonce,
      operatorApproval,
    };
  }

  async create(input: {
    requestId: string; ownerId: string; repositoryId: string; idempotencyKey: string;
    profile: unknown; submission: unknown; generation: number; nonce: string;
    operatorApproval: { operatorApproved: true; approvedBy: string; approvedAt: number };
  }): Promise<{ request: ReturnType<SigningCoordinator["public"]>; created: boolean; dispatch: ReturnType<SigningCoordinator["dispatch"]> }> {
    const submission = SigningSubmissionSchema.parse(input.submission);
    const profile = SigningProfileSchema.parse(input.profile);
    if (!profile.enabled || profile.name !== submission.profile || profile.platform !== submission.platform
      || containsCredentialMaterial(profile.policy) || !["sign","finalize","dmg_sign","dmg_finalize","windows_sign","ios_sign"].includes(String(profile.policy.stage))) throw new Error("signing_profile_not_approved");
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<StoredRow>(
        "SELECT * FROM signing_requests WHERE repository_id=? AND idempotency_key=?",
        input.repositoryId, input.idempotencyKey
      ).toArray()[0];
      if (existing) {
        if (existing.owner_id !== input.ownerId || existing.submission_json !== JSON.stringify(submission)) throw new Error("signing_idempotency_conflict");
        return { request: this.public(existing), created: false, dispatch: this.dispatch(existing) };
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO signing_requests (id,repository_id,owner_id,idempotency_key,profile_json,submission_json,state,current_stage,run_id,source_digest,source_size,output_digest,output_size,generation,nonce,created_at,completed_at)
         VALUES (?,?,?,?,?,?,'accepted',?,NULL,?,?,NULL,NULL,?,?,?,NULL)`,
        input.requestId, input.repositoryId, input.ownerId, input.idempotencyKey, JSON.stringify({ ...profile, operatorApproval: input.operatorApproval }), JSON.stringify(submission),
        String(profile.policy.stage), submission.sourceDigest, submission.sourceSize, input.generation, input.nonce, now
      );
      const row = this.row(input.requestId)!;
      return { request: this.public(row), created: true, dispatch: this.dispatch(row) };
    });
  }

  get(id: string, ownerId: string, repositoryId: string) {
    const row = this.row(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return null;
    return this.public(row);
  }

  machine(id: string, context: import("../../../../packages/contracts/src/signing").SigningMachineContext, operation: string, payload?: Record<string, unknown>) {
    const row = this.row(id);
    const terminalRead = (operation === "complete" || operation === "profile" || operation === "output-target")
      && (row?.state === "awaiting_source" || row?.state === "succeeded")
      || operation === "fail" && row?.state === "failed";
    if (!row || row.id !== context.requestId || row.owner_id !== context.ownerId || row.repository_id !== context.repositoryId
      || row.run_id !== context.runId || row.generation !== context.generation || row.nonce !== context.nonce
      || row.state !== "queued" && row.state !== "running" && !terminalRead) throw new Error("signing_lease_invalid");
    const profile = JSON.parse(row.profile_json) as Record<string, unknown>;
    const approval = profile.operatorApproval as Record<string, unknown> | undefined;
    if (profile.revision !== context.profileRevision || profile.workflowOid !== context.workflowOid
      || profile.platform !== context.platform
      || row.current_stage !== context.stage
      || approval?.operatorApproved !== true || approval.approvedBy !== context.operatorApproval.approvedBy
      || approval.approvedAt !== context.operatorApproval.approvedAt || context.operatorApproval.approvedBy !== context.ownerId
      || context.leaseExpiresAt <= Date.now()) throw new Error("signing_lease_invalid");
    if (operation === "start") {
      if (row.state !== "queued") throw new Error("signing_lease_invalid");
      const submission = JSON.parse(row.submission_json) as Record<string, unknown>;
      const policy = profile.policy as Record<string, unknown>;
      const project = policy.project as Record<string, unknown> | undefined;
      if (!project || project.enabled !== true || typeof project.id !== "string" || !Number.isSafeInteger(project.max_artifact_bytes))
        throw new Error("signing_policy_invalid");
      const common = {
        schema_version: 1,
        request_id: id,
        generation: row.generation,
        stage: row.current_stage,
        project_id: project.id,
        version: submission.version,
        source_sha: submission.sourceCommitOid,
        input_digest: previousStage(row.current_stage)
          ? this.ctx.storage.sql.exec<{ digest: string }>("SELECT digest FROM signing_stage_outputs WHERE request_id=? AND stage=?", id, previousStage(row.current_stage)!).toArray()[0]?.digest
          : row.source_digest,
        recipe_sha: profile.workflowOid,
        policy_digest: profile.policyDigest,
        max_artifact_bytes: project.max_artifact_bytes,
      };
      let manifest: Record<string, unknown>;
      if (profile.platform === "windows") {
        const windows = project.windows as Record<string, unknown> | undefined;
        const azure = policy.azure as Record<string, unknown> | undefined;
        if (!windows || !azure || !policy.windowsIdentity) throw new Error("signing_windows_profile_invalid");
        manifest = { ...common, stage: "windows_sign", identity_mode: policy.windowsIdentity, bundle_id: windows.bundle_id, architecture: windows.architecture,
          max_unpacked_bytes: windows.max_unpacked_bytes, windows: { product_name: windows.product_name, electron_version: windows.electron_version,
            executable_name: windows.executable_name, installer: windows.installer, portable: windows.portable }, azure };
      } else if (profile.platform === "ios") {
        const ios = project.ios as Record<string, unknown> | undefined;
        if (!ios || typeof policy.teamId !== "string") throw new Error("signing_ios_profile_invalid");
        manifest = { ...common, stage: "ios_sign", team_id: policy.teamId, bundle_id: ios.bundle_id,
          architecture: ios.architecture, max_unpacked_bytes: ios.max_unpacked_bytes };
      } else {
        const macos = project.macos as Record<string, unknown> | undefined;
        if (!macos || typeof policy.teamId !== "string") throw new Error("signing_macos_profile_invalid");
        const previousReport = previousStage(row.current_stage)
          ? this.ctx.storage.sql.exec<{ verification_json: string }>("SELECT verification_json FROM signing_stage_outputs WHERE request_id=? AND stage=?", id, previousStage(row.current_stage)!).toArray()[0]?.verification_json
          : null;
        const previousVerification = previousReport ? JSON.parse(previousReport) as Record<string, unknown> : null;
        manifest = { ...common, team_id: policy.teamId, bundle_id: macos.bundle_id, bundle_name: macos.bundle_name,
          architecture: macos.architecture, profile: macos.profile, harden_electron_fuses: macos.harden_electron_fuses,
          max_unpacked_bytes: macos.max_unpacked_bytes,
          ...(["finalize","dmg_finalize"].includes(row.current_stage) && previousVerification ? {
            notarization_id: previousVerification.notarization_id,
            notary_archive_sha256: previousVerification.notary_archive_sha256,
          } : {}),
          ...(row.current_stage === "dmg_sign" ? { template_digest: row.source_digest } : {}),
        };
      }
      const started = this.ctx.storage.sql.exec("UPDATE signing_requests SET state='running' WHERE id=? AND state='queued'", id).rowsWritten;
      if (!started) throw new Error("signing_lease_invalid");
      return { state: "running", manifest };
    }
    if (operation === "fail" && row.state === "failed") return { state: "failed" };
    if (row.state !== "running") throw new Error("signing_lease_invalid");
    if (operation === "download") {
      if (payload?.object !== undefined && payload.object !== "input" && payload.object !== "template") throw new Error("signing_object_invalid");
      if (payload?.object === "template") throw new Error("signing_template_unavailable");
      const input = previousStage(row.current_stage)
        ? this.ctx.storage.sql.exec<{ digest: string; size: number }>("SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?", id, previousStage(row.current_stage)!).toArray()[0]
        : null;
      if (previousStage(row.current_stage) && !input) throw new Error("signing_input_unavailable");
      if (input) return { key: `signing/${row.owner_id}/${row.repository_id}/${id}/${previousStage(row.current_stage)}.zip`, digest: input.digest, size: input.size };
      return { key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/source.zip`, digest: row.source_digest, size: row.source_size };
    }
    if (operation === "profile") {
      const previous = previousStage(row.current_stage)
        ? this.ctx.storage.sql.exec<{ digest: string }>("SELECT digest FROM signing_stage_outputs WHERE request_id=? AND stage=?", id, previousStage(row.current_stage)!).toArray()[0]
        : null;
      return { profile, sourceDigest: previous?.digest ?? row.source_digest, sourceCommitOid: JSON.parse(row.submission_json).sourceCommitOid, version: JSON.parse(row.submission_json).version };
    }
    if (operation === "output-target") {
      if (!row.output_digest || !row.output_size) throw new Error("signing_output_invalid");
      const upload = this.ctx.storage.sql.exec<{ verified: number }>("SELECT verified FROM signing_uploads WHERE request_id=?", id).toArray()[0];
      if (!upload?.verified) throw new Error("signing_output_invalid");
      return { key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/${row.current_stage}.zip`, digest: row.output_digest, size: row.output_size };
    }
    if (operation === "heartbeat") return { leaseExpiresAt: context.leaseExpiresAt };
    if (operation === "authorize-sign") {
      this.ctx.storage.sql.exec("UPDATE signing_requests SET authorized_at=? WHERE id=? AND state='running'", Date.now(), id);
      return { authorized: true };
    }
    if (operation === "output") {
      if (row.authorized_at <= 0) throw new Error("signing_not_authorized");
      const digest = String(payload?.digest ?? "");
      const size = Number(payload?.size);
      if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 1 || size > 2_000_000_000)
        throw new Error("signing_output_invalid");
      if ((row.output_digest && row.output_digest !== digest) || (row.output_size && row.output_size !== size))
        throw new Error("signing_output_invalid");
      this.ctx.storage.sql.exec("UPDATE signing_requests SET output_digest=?,output_size=? WHERE id=? AND state='running'", digest, size, id);
      return { key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/${row.current_stage}.zip`, digest, size };
    }
    if (operation === "output-upload") {
      if (row.authorized_at <= 0) throw new Error("signing_not_authorized");
      return { authorized: true };
    }
    if (operation === "complete") {
      const persistedState = String(row.state);
      if ((persistedState === "succeeded" || persistedState === "awaiting_source") && row.output_digest === payload?.digest && row.output_size === payload?.size
        && row.verification_json === JSON.stringify(payload?.verificationReport)) return { state: persistedState };
      if (!row.output_digest || !row.output_size || payload?.digest !== row.output_digest || payload?.size !== row.output_size)
        throw new Error("signing_output_invalid");
      if (row.authorized_at <= 0 || typeof payload?.verificationReport !== "object" || payload.verificationReport === null)
        throw new Error("signing_not_authorized");
      const profile = JSON.parse(row.profile_json) as { platform: string; policy: { project?: { macos?: { output_format?: string } } } };
      const terminal = profile.platform === "windows" || profile.platform === "ios"
        || profile.platform === "macos" && row.current_stage === "finalize";
      const state = terminal ? "succeeded" : "awaiting_source";
      if (!terminal) this.ctx.storage.sql.exec(
        "INSERT INTO signing_stage_outputs(request_id,stage,digest,size,verification_json) VALUES (?,?,?,?,?) ON CONFLICT(request_id,stage) DO UPDATE SET digest=excluded.digest,size=excluded.size,verification_json=excluded.verification_json",
        id, row.current_stage, row.output_digest, row.output_size, JSON.stringify(payload.verificationReport)
      );
      this.ctx.storage.sql.exec("UPDATE signing_requests SET state=?,completed_at=?,verification_json=? WHERE id=? AND state='running'",
        state, terminal ? Date.now() : null, JSON.stringify(payload.verificationReport), id);
      return { state };
    }
    if (operation === "fail") {
      if (row.state !== "running") throw new Error("signing_lease_invalid");
      const code = typeof payload?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(payload.code) ? payload.code : "signing_execution_failed";
      this.ctx.storage.sql.exec("UPDATE signing_requests SET state='failed',completed_at=?,verification_json=? WHERE id=? AND state='running'", Date.now(), JSON.stringify({ error: code }), id);
      return { state: "failed" };
    }
    throw new Error("signing_operation_invalid");
  }

  private outputUpload(id: string) {
    return this.ctx.storage.sql.exec<{ request_id: string; upload_id: string; digest: string; size: number; part_size: number; part_count: number; verified: number }>(
      "SELECT * FROM signing_uploads WHERE request_id=?", id
    ).toArray()[0] ?? null;
  }

  async beginOutput(id: string, context: import("../../../../packages/contracts/src/signing").SigningMachineContext, digest: string, size: number) {
    this.machine(id, context, "output", { digest, size });
    const existing = this.outputUpload(id);
    if (existing) {
      if (existing.digest !== digest || existing.size !== size) throw new Error("signing_output_invalid");
      return { partSize: existing.part_size, partCount: existing.part_count, receivedParts: this.ctx.storage.sql.exec<{ part: number }>("SELECT part FROM signing_upload_parts WHERE request_id=? ORDER BY part", id).toArray().map(value => value.part), verified: Boolean(existing.verified) };
    }
    const owner = this.row(id)!;
    const key = `signing/${owner.owner_id}/${owner.repository_id}/${id}/${owner.current_stage}.zip`;
    const partSize = 8 * 1024 * 1024;
    const partCount = Math.ceil(size / partSize);
    const upload = await this.env.SIGNING_ARTIFACTS.createMultipartUpload(key, {
      customMetadata: { ownerId: owner.owner_id, repositoryId: owner.repository_id, requestId: id, sha256: digest, size: String(size) },
    });
    const inserted = this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO signing_uploads(request_id,upload_id,digest,size,part_size,part_count) VALUES (?,?,?,?,?,?)",
      id, upload.uploadId, digest, size, partSize, partCount
    ).rowsWritten > 0);
    if (!inserted) await upload.abort();
    const current = this.outputUpload(id)!;
    if (current.digest !== digest || current.size !== size) throw new Error("signing_output_invalid");
    return { partSize: current.part_size, partCount: current.part_count, receivedParts: [], verified: Boolean(current.verified) };
  }

  authorizeOutputPart(id: string, context: import("../../../../packages/contracts/src/signing").SigningMachineContext, part: number, length: number) {
    this.machine(id, context, "output-upload");
    const upload = this.outputUpload(id);
    if (!upload || upload.verified) throw new Error("signing_output_invalid");
    if (!Number.isInteger(part) || part < 1 || part > upload.part_count) throw new Error("signing_part_invalid");
    const expected = part < upload.part_count ? upload.part_size : upload.size - (upload.part_count - 1) * upload.part_size;
    if (length !== expected) throw new Error("signing_part_invalid");
    const row = this.row(id)!;
    return { key: `signing/${row.owner_id}/${row.repository_id}/${id}/${row.current_stage}.zip`, uploadId: upload.upload_id, expected, total: upload.size };
  }

  recordOutputPart(id: string, context: import("../../../../packages/contracts/src/signing").SigningMachineContext, part: number, etag: string, size: number) {
    this.authorizeOutputPart(id, context, part, size);
    this.ctx.storage.sql.exec("INSERT INTO signing_upload_parts(request_id,part,etag,size) VALUES (?,?,?,?) ON CONFLICT(request_id,part) DO UPDATE SET etag=excluded.etag,size=excluded.size", id, part, etag, size);
    return { part, receivedParts: this.ctx.storage.sql.exec<{ part: number }>("SELECT part FROM signing_upload_parts WHERE request_id=? ORDER BY part", id).toArray().map(value => value.part) };
  }

  async finishOutput(id: string, context: import("../../../../packages/contracts/src/signing").SigningMachineContext) {
    this.machine(id, context, "output-upload");
    const upload = this.outputUpload(id);
    if (!upload) throw new Error("signing_output_invalid");
    if (upload.verified) return { digest: upload.digest, size: upload.size, verified: true };
    const row = this.row(id)!;
    const key = `signing/${row.owner_id}/${row.repository_id}/${id}/${row.current_stage}.zip`;
    const completed = await this.env.SIGNING_ARTIFACTS.get(key);
    if (completed) {
      const hash = new crypto.DigestStream("SHA-256");
      await completed.body.pipeTo(hash);
      const actual = `sha256:${Array.from(new Uint8Array(await hash.digest), value => value.toString(16).padStart(2, "0")).join("")}`;
      if (completed.size === upload.size && actual === upload.digest) {
        this.ctx.storage.sql.exec("UPDATE signing_uploads SET verified=1 WHERE request_id=? AND upload_id=?", id, upload.upload_id);
        return { digest: upload.digest, size: upload.size, verified: true };
      }
      await this.env.SIGNING_ARTIFACTS.delete(key);
    }
    const parts = this.ctx.storage.sql.exec<{ part: number; etag: string; size: number }>("SELECT part,etag,size FROM signing_upload_parts WHERE request_id=? ORDER BY part", id).toArray();
    if (parts.length !== upload.part_count || parts.some((value, index) => {
      const expected = index + 1 < upload.part_count ? upload.part_size : upload.size - (upload.part_count - 1) * upload.part_size;
      return value.part !== index + 1 || value.size !== expected;
    })) throw new Error("signing_parts_incomplete");
    await this.env.SIGNING_ARTIFACTS.resumeMultipartUpload(key, upload.upload_id).complete(parts.map(value => ({ partNumber: value.part, etag: value.etag })));
    const object = await this.env.SIGNING_ARTIFACTS.get(key);
    if (!object || object.size !== upload.size) { await object?.body.cancel(); await this.env.SIGNING_ARTIFACTS.delete(key); throw new Error("signing_output_invalid"); }
    const digest = new crypto.DigestStream("SHA-256");
    await object.body.pipeTo(digest);
    const actual = Array.from(new Uint8Array(await digest.digest), value => value.toString(16).padStart(2, "0")).join("");
    if (`sha256:${actual}` !== upload.digest) { await this.env.SIGNING_ARTIFACTS.delete(key); throw new Error("signing_output_invalid"); }
    this.ctx.storage.sql.exec("UPDATE signing_uploads SET verified=1 WHERE request_id=? AND upload_id=?", id, upload.upload_id);
    return { digest: upload.digest, size: upload.size, verified: true };
  }

  bindRun(id: string, ownerId: string, repositoryId: string, runId: string): boolean {
    const row = this.row(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return false;
    if (row.run_id && row.run_id !== runId) throw new Error("signing_run_conflict");
    this.ctx.storage.sql.exec(
      "UPDATE signing_requests SET run_id=?,state='queued' WHERE id=? AND owner_id=? AND repository_id=? AND state IN ('accepted','queued')",
      runId, id, ownerId, repositoryId
    );
    return true;
  }

  prepareNextStage(id: string, ownerId: string, repositoryId: string, nonce: string) {
    const row = this.row(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return null;
    if (row.state === "accepted" && !row.run_id) {
      const previous = previousStage(row.current_stage);
      const output = previous
        ? this.ctx.storage.sql.exec<{ digest: string; size: number }>("SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?", id, previous).toArray()[0]
        : null;
      if (!output) return { request: this.public(row), dispatch: null };
      return { request: this.public(row), dispatch: { ...this.dispatch(row), stage: row.current_stage, inputDigest: output.digest, inputSize: output.size } };
    }
    if (row.state !== "awaiting_source") return { request: this.public(row), dispatch: null };
    const profile = JSON.parse(row.profile_json) as { policy: { project?: { macos?: { output_format?: string } } } };
    const next = nextStage(row.current_stage, profile.policy.project?.macos?.output_format);
    if (!next) return { request: this.public(row), dispatch: null };
    const output = this.ctx.storage.sql.exec<{ digest: string; size: number }>("SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?", id, row.current_stage).toArray()[0];
    if (!output) throw new Error("signing_stage_output_unavailable");
    const advanced = this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='accepted',current_stage=?,run_id=NULL,output_digest=NULL,output_size=NULL,authorized_at=0,verification_json=NULL,generation=generation+1,nonce=? WHERE id=? AND state='awaiting_source' AND current_stage=?",
        next, nonce, id, row.current_stage
      ).rowsWritten;
      if (changed) {
        this.ctx.storage.sql.exec("DELETE FROM signing_upload_parts WHERE request_id=?", id);
        this.ctx.storage.sql.exec("DELETE FROM signing_uploads WHERE request_id=?", id);
      }
      return changed > 0;
    });
    const current = this.row(id)!;
    return { request: this.public(current), dispatch: advanced ? { ...this.dispatch(current), stage: next, inputDigest: output.digest, inputSize: output.size } : null };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && parts[0] === "create") {
      const body = await request.json() as Parameters<SigningCoordinator["create"]>[0];
      return Response.json(await this.create(body));
    }
    if (request.method === "GET" && parts[0] === "requests" && parts[1]) {
      const ownerId = request.headers.get("X-Signing-Owner") ?? "";
      const repositoryId = request.headers.get("X-Signing-Repository") ?? "";
      const requestData = this.get(parts[1], ownerId, repositoryId);
      return requestData ? Response.json({ request: requestData }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "POST" && parts[0] === "bind-run" && parts[1]) {
      const body = await request.json() as { ownerId: string; repositoryId: string; runId: string };
      return Response.json({ bound: this.bindRun(parts[1], body.ownerId, body.repositoryId, body.runId) });
    }
    if (request.method === "POST" && parts[0] === "prepare-next-stage" && parts[1]) {
      const body = await request.json() as { ownerId: string; repositoryId: string; nonce: string };
      try { return Response.json({ data: this.prepareNextStage(parts[1], body.ownerId, body.repositoryId, body.nonce) }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "signing_stage_error" }, { status: 409 }); }
    }
    if (request.method === "POST" && parts[0] === "machine" && parts[1] && parts[2]) {
      const body = await request.json() as { context: import("../../../../packages/contracts/src/signing").SigningMachineContext; payload?: Record<string, unknown> };
      try {
        if (parts[2] === "output-begin") return Response.json({ data: await this.beginOutput(parts[1], body.context, String(body.payload?.digest), Number(body.payload?.size)) });
        if (parts[2] === "output-part") return Response.json({ data: this.authorizeOutputPart(parts[1], body.context, Number(body.payload?.part), Number(body.payload?.length)) });
        if (parts[2] === "output-record") return Response.json({ data: this.recordOutputPart(parts[1], body.context, Number(body.payload?.part), String(body.payload?.etag), Number(body.payload?.size)) });
        if (parts[2] === "output-complete") return Response.json({ data: await this.finishOutput(parts[1], body.context) });
        return Response.json({ data: this.machine(parts[1], body.context, parts[2], body.payload) });
      }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "signing_machine_error" }, { status: 409 }); }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

function containsCredentialMaterial(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  const blocked = /^(?:secret|secrets|credential|credentials|password|private_?key|certificate_p12|certificate_password|access_?token|api_?key)$/i;
  return Object.entries(value).some(([key, child]) => blocked.test(key) || containsCredentialMaterial(child));
}

function previousStage(stage: string): string | null {
  if (stage === "finalize") return "sign";
  if (stage === "dmg_sign") return "finalize";
  if (stage === "dmg_finalize") return "dmg_sign";
  return null;
}

function nextStage(stage: string, outputFormat?: string): string | null {
  if (stage === "sign") return "finalize";
  void outputFormat;
  return null;
}

export function coordinator(env: SigningEnv, ownerId: string) {
  return env.SIGNING_COORDINATORS.getByName(ownerId);
}

export async function queueSigningRequest(
  profile: { revision: string; workflowOid: string; workflowPath: string; workflowSource: string; platform: "windows" | "macos" | "ios"; timeoutMinutes: number; policy: Record<string, unknown> },
  request: SigningStoredRequest,
  hooks: SigningExecutionHooks,
  repositoryId: string
): Promise<{ runId: string }> {
  const input: SigningQueueInput = {
    requestId: request.id,
    ownerId: request.ownerId,
    repositoryId,
    workflowOid: profile.workflowOid,
    workflowPath: profile.workflowPath,
    workflowSource: profile.workflowSource,
    stage: request.stage,
    inputDigest: request.outputDigest ?? request.sourceDigest,
    platform: profile.platform,
    generation: request.generation,
    nonce: request.nonce,
    timeoutMinutes: profile.timeoutMinutes,
    sourceDigest: request.sourceDigest,
    profileRevision: profile.revision,
    operatorApproval: request.operatorApproval,
  };
  return hooks.enqueue(input);
}
