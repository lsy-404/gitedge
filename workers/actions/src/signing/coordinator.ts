import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  SigningCreateInputSchema,
  SigningMachineContextSchema,
  SigningRequestSchema,
  SigningProfileSchema,
  SigningReconcileDispatchSchema,
  SigningSubmissionSchema,
  type SigningMachineContext,
} from "../../../../packages/contracts/src/signing";
import {
  manifestSchema,
  macosVerificationSchema,
} from "../../../../packages/contracts/signing-native.mjs";
import { readJsonLimited } from "../../../../src/worker/common/readText";
import { createLogger } from "../../../../src/worker/common/logger";
import type {
  SigningEnv,
  SigningExecutionHooks,
  SigningQueueInput,
  SigningStoredRequest,
  SigningRetryDetails,
  SigningRetryResult,
  SigningRetrySnapshot,
} from "./types";

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
  expires_at: number;
}

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
        expires_at INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS signing_results (request_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS signing_source_uploads (
        request_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signing_source_parts (
        request_id TEXT NOT NULL, part INTEGER NOT NULL, etag TEXT NOT NULL,
        size INTEGER NOT NULL, PRIMARY KEY(request_id, part)
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
    ctx.waitUntil?.(
      this.scheduleExpiry().catch((error) =>
        createLogger(undefined, { service: "actions-signing", doId: ctx.id.toString() }).warn(
          "signing:expiry-schedule-failed",
          { errorType: error instanceof Error ? error.name : "unknown" }
        )
      )
    );
  }

  private async scheduleExpiry() {
    const next = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT MIN(expires_at) AS expires_at FROM signing_requests WHERE state NOT IN ('succeeded','failed','cancelled')"
      )
      .toArray()[0]?.expires_at;
    const sourceNext = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT MIN(expires_at) AS expires_at FROM signing_source_uploads"
      )
      .toArray()[0]?.expires_at;
    const resultNext = this.ctx.storage.sql
      .exec<{ expires_at: number }>("SELECT MIN(expires_at) AS expires_at FROM signing_results")
      .toArray()[0]?.expires_at;
    const earliest = [next, sourceNext, resultNext].filter((value): value is number =>
      Boolean(value)
    );
    if (earliest.length)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...earliest)));
  }

  private expire(id: string) {
    const row = this.row(id);
    if (
      !row ||
      row.expires_at > Date.now() ||
      ["succeeded", "failed", "cancelled"].includes(row.state)
    )
      return row;
    {
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='failed',completed_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')",
        Date.now(),
        id
      );
      return this.row(id);
    }
  }

  async alarm() {
    const expired = this.ctx.storage.sql
      .exec<StoredRow>(
        "SELECT * FROM signing_requests WHERE expires_at<=? AND state NOT IN ('succeeded','failed','cancelled')",
        Date.now()
      )
      .toArray();
    for (const row of expired) {
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='failed',completed_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')",
        Date.now(),
        row.id
      );
    }
    const sources = this.ctx.storage.sql
      .exec<{ request_id: string }>(
        "SELECT request_id FROM signing_source_uploads WHERE expires_at<=?",
        Date.now()
      )
      .toArray();
    for (const source of sources) {
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='failed',completed_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')",
        Date.now(),
        source.request_id
      );
      const row = this.row(source.request_id);
      if (row?.run_id) {
        await this.env.DB.prepare(
          "UPDATE actions_runner_runs SET status='completed',conclusion='failure',completed_at=?,lease_expires_at=? WHERE run_id=? AND status IN ('queued','running')"
        )
          .bind(Date.now(), Date.now(), row.run_id)
          .run();
      }
      await this.releaseSource(source.request_id);
    }
    const results = this.ctx.storage.sql
      .exec<{ request_id: string }>(
        "SELECT request_id FROM signing_results WHERE expires_at<=?",
        Date.now()
      )
      .toArray();
    for (const result of results) {
      const row = this.row(result.request_id);
      if (row) await this.releaseResult(row.id, row.owner_id, row.repository_id);
    }
    await this.scheduleExpiry();
  }

  async releaseResult(id: string, ownerId: string, repositoryId: string) {
    const row = this.row(id);
    if (
      !row ||
      row.owner_id !== ownerId ||
      row.repository_id !== repositoryId ||
      row.state !== "succeeded"
    )
      throw new Error("signing_result_invalid");
    await this.env.SIGNING_ARTIFACTS.delete(
      `signing/${ownerId}/${repositoryId}/${id}/${row.current_stage}.zip`
    );
    this.ctx.storage.sql.exec("DELETE FROM signing_results WHERE request_id=?", id);
  }

  async releaseSource(id: string) {
    const row = this.row(id);
    const upload = this.ctx.storage.sql
      .exec<{ upload_id: string }>(
        "SELECT upload_id FROM signing_source_uploads WHERE request_id=?",
        id
      )
      .toArray()[0];
    if (!row || !upload) return;
    const key = `signing/${row.owner_id}/${row.repository_id}/${id}/source.zip`;
    if (row.state === "succeeded" && row.completed_at) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO signing_results VALUES (?,?)",
        id,
        row.completed_at + 3 * 60 * 60 * 1000
      );
      this.ctx.waitUntil(this.scheduleExpiry());
    }
    if (upload.upload_id !== "pending" && upload.upload_id !== "complete") {
      try {
        await this.env.SIGNING_ARTIFACTS.resumeMultipartUpload(key, upload.upload_id).abort();
      } catch {
        /* upload may already be complete */
      }
    }
    const stageKeys = ["sign", "finalize", "dmg_sign", "dmg_finalize", "windows_sign", "ios_sign"]
      .filter((stage) => row.state !== "succeeded" || stage !== row.current_stage)
      .map((stage) => `signing/${row.owner_id}/${row.repository_id}/${id}/${stage}.zip`);
    await this.env.SIGNING_ARTIFACTS.delete([key, ...stageKeys]);
    this.ctx.storage.sql.exec("DELETE FROM signing_source_parts WHERE request_id=?", id);
    this.ctx.storage.sql.exec("DELETE FROM signing_source_uploads WHERE request_id=?", id);
  }

  sourceUpload(id: string, ownerId: string, repositoryId: string) {
    const row = this.row(id);
    if (
      !row ||
      row.owner_id !== ownerId ||
      row.repository_id !== repositoryId ||
      row.state !== "accepted"
    )
      throw new Error("signing_source_invalid");
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO signing_source_uploads VALUES (?,'pending',?)",
      id,
      Date.now() + 3 * 60 * 60 * 1000
    );
    this.ctx.waitUntil(this.scheduleExpiry());
    const upload = this.ctx.storage.sql
      .exec<{ upload_id: string; expires_at: number }>(
        "SELECT upload_id,expires_at FROM signing_source_uploads WHERE request_id=?",
        id
      )
      .toArray()[0];
    if (!upload || upload.expires_at <= Date.now()) throw new Error("signing_source_expired");
    const partSize = 8 * 1024 * 1024;
    return {
      request: this.public(row),
      dispatch: this.dispatch(row),
      key: `signing/${ownerId}/${repositoryId}/${id}/source.zip`,
      uploadId: upload.upload_id,
      partSize,
      partCount: Math.ceil(row.source_size / partSize),
      receivedParts: this.ctx.storage.sql
        .exec<{ part: number }>(
          "SELECT part FROM signing_source_parts WHERE request_id=? ORDER BY part",
          id
        )
        .toArray()
        .map((part) => part.part),
    };
  }

  bindSourceUpload(id: string, ownerId: string, repositoryId: string, uploadId: string) {
    this.sourceUpload(id, ownerId, repositoryId);
    this.ctx.storage.sql.exec(
      "UPDATE signing_source_uploads SET upload_id=? WHERE request_id=? AND upload_id='pending'",
      uploadId,
      id
    );
    return this.sourceUpload(id, ownerId, repositoryId);
  }

  recordSourcePart(
    id: string,
    ownerId: string,
    repositoryId: string,
    part: number,
    etag: string,
    size: number
  ) {
    const plan = this.sourceUpload(id, ownerId, repositoryId);
    const expected =
      part < plan.partCount
        ? plan.partSize
        : plan.request.sourceSize - (plan.partCount - 1) * plan.partSize;
    if (
      !Number.isInteger(part) ||
      part < 1 ||
      part > plan.partCount ||
      size !== expected ||
      plan.uploadId === "pending" ||
      plan.uploadId === "complete"
    )
      throw new Error("signing_part_invalid");
    this.ctx.storage.sql.exec(
      "INSERT INTO signing_source_parts VALUES (?,?,?,?) ON CONFLICT(request_id,part) DO UPDATE SET etag=excluded.etag,size=excluded.size",
      id,
      part,
      etag,
      size
    );
    return { part };
  }

  sourceCompletion(id: string, ownerId: string, repositoryId: string) {
    const plan = this.sourceUpload(id, ownerId, repositoryId);
    const parts = this.ctx.storage.sql
      .exec<{ part: number; etag: string; size: number }>(
        "SELECT part,etag,size FROM signing_source_parts WHERE request_id=? ORDER BY part",
        id
      )
      .toArray();
    if (
      plan.uploadId !== "complete" &&
      (plan.uploadId === "pending" ||
        parts.length !== plan.partCount ||
        parts.some(
          (p, index) =>
            p.part !== index + 1 ||
            p.size !==
              (p.part < plan.partCount
                ? plan.partSize
                : plan.request.sourceSize - (plan.partCount - 1) * plan.partSize)
        ))
    )
      throw new Error("signing_parts_incomplete");
    return { ...plan, parts: parts.map((p) => ({ partNumber: p.part, etag: p.etag })) };
  }

  markSourceComplete(id: string, ownerId: string, repositoryId: string) {
    this.sourceUpload(id, ownerId, repositoryId);
    this.ctx.storage.sql.exec(
      "UPDATE signing_source_uploads SET upload_id='complete' WHERE request_id=?",
      id
    );
  }

  expiredUpload(id: string, ownerId: string, repositoryId: string) {
    const row = this.row(id);
    if (
      !row ||
      row.owner_id !== ownerId ||
      row.repository_id !== repositoryId ||
      row.state !== "failed"
    )
      return null;
    const upload = this.ctx.storage.sql
      .exec<{ upload_id: string }>(
        "SELECT upload_id FROM signing_uploads WHERE request_id=? AND verified=0",
        id
      )
      .toArray()[0];
    return upload
      ? {
          key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/${row.current_stage}.zip`,
          uploadId: upload.upload_id,
        }
      : null;
  }

  listSourceRun(ownerId: string, repositoryId: string, sourceRunId: string) {
    return this.ctx.storage.sql
      .exec<StoredRow>(
        "SELECT * FROM signing_requests WHERE owner_id=? AND repository_id=? AND json_extract(submission_json,'$.sourceRunId')=? ORDER BY created_at DESC LIMIT 101",
        ownerId,
        repositoryId,
        sourceRunId
      )
      .toArray()
      .map((row) => ({
        request: this.public(row),
        submission: SigningSubmissionSchema.parse(JSON.parse(row.submission_json)),
      }));
  }

  private row(id: string): StoredRow | null {
    return (
      this.ctx.storage.sql
        .exec<StoredRow>("SELECT * FROM signing_requests WHERE id=?", id)
        .toArray()[0] ?? null
    );
  }

  private public(row: StoredRow) {
    const input = SigningSubmissionSchema.parse(JSON.parse(row.submission_json));
    const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
    return SigningRequestSchema.parse({
      id: row.id,
      repositoryId: row.repository_id,
      ownerId: row.owner_id,
      profile: input.profile,
      profileRevision: profile.revision,
      platform: input.platform,
      stage: row.current_stage,
      runId: row.run_id,
      state: row.state,
      sourceDigest: row.source_digest,
      sourceSize: row.source_size,
      outputDigest: row.output_digest,
      outputSize: row.output_size,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
    });
  }

  private dispatch(row: StoredRow) {
    const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
    return {
      profile,
      submission: SigningSubmissionSchema.parse(JSON.parse(row.submission_json)),
      generation: row.generation,
      nonce: row.nonce,
    };
  }

  private previousVerification(row: StoredRow) {
    if (SigningProfileSchema.parse(JSON.parse(row.profile_json)).platform !== "macos") return null;
    const stage = previousStage(row.current_stage);
    if (!stage) return null;
    const saved = this.ctx.storage.sql
      .exec<{ verification_json: string }>(
        "SELECT verification_json FROM signing_stage_outputs WHERE request_id=? AND stage=?",
        row.id,
        stage
      )
      .toArray()[0];
    return saved ? macosVerificationSchema.parse(JSON.parse(saved.verification_json)) : null;
  }

  async create(raw: unknown): Promise<{
    request: ReturnType<SigningCoordinator["public"]>;
    created: boolean;
    dispatch: ReturnType<SigningCoordinator["dispatch"]>;
  }> {
    const input = SigningCreateInputSchema.parse(raw);
    const submission = input.submission;
    const profile = input.profile;
    if (
      !profile.enabled ||
      profile.name !== submission.profile ||
      profile.platform !== submission.platform ||
      containsCredentialMaterial(profile.policy) ||
      !["sign", "finalize", "dmg_sign", "dmg_finalize", "windows_sign", "ios_sign"].includes(
        String(profile.policy.stage)
      )
    )
      throw new Error("signing_profile_not_approved");
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<StoredRow>(
          "SELECT * FROM signing_requests WHERE repository_id=? AND idempotency_key=?",
          input.repositoryId,
          input.idempotencyKey
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.owner_id !== input.ownerId ||
          existing.submission_json !== JSON.stringify(submission)
        )
          throw new Error("signing_idempotency_conflict");
        return {
          request: this.public(existing),
          created: false,
          dispatch: this.dispatch(existing),
        };
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO signing_requests (id,repository_id,owner_id,idempotency_key,profile_json,submission_json,state,current_stage,run_id,source_digest,source_size,output_digest,output_size,generation,nonce,created_at,completed_at,expires_at)
         VALUES (?,?,?,?,?,?,'accepted',?,NULL,?,?,NULL,NULL,?,?,?,NULL,?)`,
        input.requestId,
        input.repositoryId,
        input.ownerId,
        input.idempotencyKey,
        JSON.stringify(profile),
        JSON.stringify(submission),
        String(profile.policy.stage),
        submission.sourceDigest,
        submission.sourceSize,
        input.generation,
        input.nonce,
        now,
        now + 6 * 24 * 60 * 60 * 1000
      );
      this.ctx.waitUntil?.(
        this.scheduleExpiry().catch((error) =>
          createLogger(undefined, {
            service: "actions-signing",
            doId: this.ctx.id.toString(),
            requestId: input.requestId,
          }).warn("signing:expiry-schedule-failed", {
            errorType: error instanceof Error ? error.name : "unknown",
          })
        )
      );
      const row = this.row(input.requestId)!;
      return { request: this.public(row), created: true, dispatch: this.dispatch(row) };
    });
  }

  get(id: string, ownerId: string, repositoryId: string) {
    const row = this.expire(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return null;
    return this.public(row);
  }

  machine(
    id: string,
    context: SigningMachineContext,
    operation: string,
    payload?: Record<string, unknown>
  ) {
    const row = this.expire(id);
    const terminalRead =
      ((operation === "complete" ||
        operation === "profile" ||
        operation === "output-target" ||
        operation === "output-complete") &&
        (row?.state === "awaiting_source" || row?.state === "succeeded")) ||
      (operation === "fail" && row?.state === "failed");
    if (
      !row ||
      row.id !== context.requestId ||
      row.owner_id !== context.ownerId ||
      row.repository_id !== context.repositoryId ||
      row.run_id !== context.runId ||
      row.generation !== context.generation ||
      row.nonce !== context.nonce ||
      (row.state !== "queued" && row.state !== "running" && !terminalRead)
    )
      throw new Error("signing_lease_invalid");
    const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
    if (
      profile.revision !== context.profileRevision ||
      profile.workflowOid !== context.workflowOid ||
      profile.platform !== context.platform ||
      row.current_stage !== context.stage ||
      context.leaseExpiresAt <= Date.now()
    )
      throw new Error("signing_lease_invalid");
    if (operation === "start") {
      if (row.state !== "queued") throw new Error("signing_lease_invalid");
      const submission = SigningSubmissionSchema.parse(JSON.parse(row.submission_json));
      const policy = profile.policy;
      const project = policy.project;
      const inputDigest = previousStage(row.current_stage)
        ? this.ctx.storage.sql
            .exec<{ digest: string }>(
              "SELECT digest FROM signing_stage_outputs WHERE request_id=? AND stage=?",
              id,
              previousStage(row.current_stage)!
            )
            .toArray()[0]?.digest
        : row.source_digest;
      if (!inputDigest) throw new Error("signing_input_unavailable");
      const common = {
        schema_version: 1,
        request_id: id,
        generation: row.generation,
        stage: row.current_stage,
        project_id: project.id,
        version: submission.version,
        source_sha: submission.sourceCommitOid,
        input_digest: inputDigest,
        recipe_sha: profile.workflowOid,
        policy_digest: profile.policyDigest,
        max_artifact_bytes: project.max_artifact_bytes,
      };
      let manifest: Record<string, unknown>;
      if (profile.platform === "windows") {
        const windows = project.windows;
        const azure = policy.azure;
        if (!windows || !azure) throw new Error("signing_windows_profile_invalid");
        manifest = {
          ...common,
          stage: "windows_sign",
          bundle_id: windows.bundle_id,
          architecture: windows.architecture,
          max_unpacked_bytes: windows.max_unpacked_bytes,
          windows: {
            product_name: windows.product_name,
            electron_version: windows.electron_version,
            executable_name: windows.executable_name,
            installer: windows.installer,
            portable: windows.portable,
          },
          azure,
        };
      } else if (profile.platform === "ios") {
        const ios = project.ios;
        if (!ios || !policy.teamId) throw new Error("signing_ios_profile_invalid");
        manifest = {
          ...common,
          stage: "ios_sign",
          team_id: policy.teamId,
          bundle_id: ios.bundle_id,
          architecture: ios.architecture,
          max_unpacked_bytes: ios.max_unpacked_bytes,
        };
      } else {
        const macos = project.macos;
        if (!macos || !policy.teamId) throw new Error("signing_macos_profile_invalid");
        const previousReport = previousStage(row.current_stage)
          ? this.ctx.storage.sql
              .exec<{ verification_json: string }>(
                "SELECT verification_json FROM signing_stage_outputs WHERE request_id=? AND stage=?",
                id,
                previousStage(row.current_stage)!
              )
              .toArray()[0]?.verification_json
          : null;
        const previousVerification = previousReport
          ? macosVerificationSchema.parse(JSON.parse(previousReport))
          : null;
        manifest = {
          ...common,
          team_id: policy.teamId,
          bundle_id: macos.bundle_id,
          bundle_name: macos.bundle_name,
          architecture: macos.architecture,
          profile: macos.profile,
          harden_electron_fuses: macos.harden_electron_fuses,
          max_unpacked_bytes: macos.max_unpacked_bytes,
          ...(["finalize", "dmg_finalize"].includes(row.current_stage) && previousVerification
            ? {
                notarization_id: previousVerification.notarization_id,
                notary_archive_sha256: previousVerification.notary_archive_sha256,
              }
            : {}),
          ...(row.current_stage === "dmg_sign" ? { template_digest: row.source_digest } : {}),
        };
      }
      manifestSchema.parse(manifest);
      const started = this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='running' WHERE id=? AND state='queued'",
        id
      ).rowsWritten;
      if (!started) throw new Error("signing_lease_invalid");
      return { state: "running", manifest };
    }
    if (operation === "fail" && row.state === "failed") return { state: "failed" };
    if (operation === "heartbeat") return { leaseExpiresAt: context.leaseExpiresAt };
    if (operation === "fail") {
      const code =
        typeof payload?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(payload.code)
          ? payload.code
          : "signing_execution_failed";
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='failed',completed_at=?,verification_json=? WHERE id=? AND state IN ('queued','running')",
        Date.now(),
        JSON.stringify({ error: code }),
        id
      );
      return { state: "failed" };
    }
    if (operation === "profile") {
      const submission = SigningSubmissionSchema.parse(JSON.parse(row.submission_json));
      const previous = previousStage(row.current_stage)
        ? this.ctx.storage.sql
            .exec<{ digest: string }>(
              "SELECT digest FROM signing_stage_outputs WHERE request_id=? AND stage=?",
              id,
              previousStage(row.current_stage)!
            )
            .toArray()[0]
        : null;
      return {
        profile,
        submission,
        sourceDigest: previous?.digest ?? row.source_digest,
        sourceCommitOid: submission.sourceCommitOid,
        version: submission.version,
      };
    }
    if (row.state !== "running") throw new Error("signing_lease_invalid");
    if (operation === "download") {
      if (
        payload?.object !== undefined &&
        payload.object !== "input" &&
        payload.object !== "template"
      )
        throw new Error("signing_object_invalid");
      if (payload?.object === "template") {
        const submission = SigningSubmissionSchema.parse(JSON.parse(row.submission_json));
        if (row.current_stage !== "dmg_sign") throw new Error("signing_object_invalid");
        return {
          key: `signing/${row.owner_id}/${row.repository_id}/${id}/source.zip`,
          digest: row.source_digest,
          size: submission.sourceSize,
        };
      }
      const input = previousStage(row.current_stage)
        ? this.ctx.storage.sql
            .exec<{ digest: string; size: number }>(
              "SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?",
              id,
              previousStage(row.current_stage)!
            )
            .toArray()[0]
        : null;
      if (previousStage(row.current_stage) && !input) throw new Error("signing_input_unavailable");
      if (input)
        return {
          key: `signing/${row.owner_id}/${row.repository_id}/${id}/${previousStage(row.current_stage)}.zip`,
          digest: input.digest,
          size: input.size,
        };
      return {
        key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/source.zip`,
        digest: row.source_digest,
        size: row.source_size,
      };
    }
    if (operation === "output-target") {
      if (!row.output_digest || !row.output_size) throw new Error("signing_output_invalid");
      const upload = this.ctx.storage.sql
        .exec<{ verified: number }>("SELECT verified FROM signing_uploads WHERE request_id=?", id)
        .toArray()[0];
      if (!upload?.verified) throw new Error("signing_output_invalid");
      return {
        key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/${row.current_stage}.zip`,
        digest: row.output_digest,
        size: row.output_size,
      };
    }
    if (operation === "output-complete") return { allowed: true };
    if (operation === "output-verified") return { allowed: true };
    if (operation === "authorize-sign") {
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET authorized_at=? WHERE id=? AND state='running'",
        Date.now(),
        id
      );
      return { authorized: true };
    }
    if (operation === "output") {
      if (row.authorized_at <= 0) throw new Error("signing_not_authorized");
      const digest = String(payload?.digest ?? "");
      const size = Number(payload?.size);
      if (
        !/^sha256:[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 2_000_000_000
      )
        throw new Error("signing_output_invalid");
      if (
        (row.output_digest && row.output_digest !== digest) ||
        (row.output_size && row.output_size !== size)
      )
        throw new Error("signing_output_invalid");
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET output_digest=?,output_size=? WHERE id=? AND state='running'",
        digest,
        size,
        id
      );
      return {
        key: `signing/${row.owner_id}/${row.repository_id}/${row.id}/${row.current_stage}.zip`,
        digest,
        size,
      };
    }
    if (operation === "output-upload") {
      if (row.authorized_at <= 0) throw new Error("signing_not_authorized");
      return { authorized: true };
    }
    if (operation === "complete") {
      const persistedState = String(row.state);
      if (
        (persistedState === "succeeded" || persistedState === "awaiting_source") &&
        row.output_digest === payload?.digest &&
        row.output_size === payload?.size &&
        row.verification_json === JSON.stringify(payload?.verificationReport)
      )
        return { state: persistedState };
      if (
        !row.output_digest ||
        !row.output_size ||
        payload?.digest !== row.output_digest ||
        payload?.size !== row.output_size
      )
        throw new Error("signing_output_invalid");
      if (
        row.authorized_at <= 0 ||
        typeof payload?.verificationReport !== "object" ||
        payload.verificationReport === null
      )
        throw new Error("signing_not_authorized");
      const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
      const terminal =
        profile.platform === "windows" ||
        profile.platform === "ios" ||
        (profile.platform === "macos" &&
          (row.current_stage === "dmg_finalize" ||
            (row.current_stage === "finalize" &&
              profile.policy.project.macos?.output_format !== "dmg")));
      const state = terminal ? "succeeded" : "awaiting_source";
      if (!terminal)
        this.ctx.storage.sql.exec(
          "INSERT INTO signing_stage_outputs(request_id,stage,digest,size,verification_json) VALUES (?,?,?,?,?) ON CONFLICT(request_id,stage) DO UPDATE SET digest=excluded.digest,size=excluded.size,verification_json=excluded.verification_json",
          id,
          row.current_stage,
          row.output_digest,
          row.output_size,
          JSON.stringify(payload.verificationReport)
        );
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state=?,completed_at=?,verification_json=? WHERE id=? AND state='running'",
        state,
        terminal ? Date.now() : null,
        JSON.stringify(payload.verificationReport),
        id
      );
      return { state };
    }
    throw new Error("signing_operation_invalid");
  }

  private outputUpload(id: string) {
    return (
      this.ctx.storage.sql
        .exec<{
          request_id: string;
          upload_id: string;
          digest: string;
          size: number;
          part_size: number;
          part_count: number;
          verified: number;
        }>("SELECT * FROM signing_uploads WHERE request_id=?", id)
        .toArray()[0] ?? null
    );
  }

  beginOutput(id: string, context: SigningMachineContext, digest: string, size: number) {
    this.machine(id, context, "output", { digest, size });
    const existing = this.outputUpload(id);
    if (existing) {
      if (existing.digest !== digest || existing.size !== size)
        throw new Error("signing_output_invalid");
      return {
        key: this.outputKey(id),
        uploadId: existing.upload_id,
        partSize: existing.part_size,
        partCount: existing.part_count,
        receivedParts: this.ctx.storage.sql
          .exec<{ part: number }>(
            "SELECT part FROM signing_upload_parts WHERE request_id=? ORDER BY part",
            id
          )
          .toArray()
          .map((value) => value.part),
        verified: Boolean(existing.verified),
      };
    }
    const owner = this.row(id)!;
    const partSize = 8 * 1024 * 1024;
    const partCount = Math.ceil(size / partSize);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO signing_uploads(request_id,upload_id,digest,size,part_size,part_count) VALUES (?,'pending',?,?,?,?)",
      id,
      digest,
      size,
      partSize,
      partCount
    );
    const current = this.outputUpload(id)!;
    if (current.digest !== digest || current.size !== size)
      throw new Error("signing_output_invalid");
    return {
      key: `signing/${owner.owner_id}/${owner.repository_id}/${id}/${owner.current_stage}.zip`,
      uploadId: current.upload_id,
      partSize: current.part_size,
      partCount: current.part_count,
      receivedParts: [],
      verified: Boolean(current.verified),
    };
  }

  outputKey(id: string) {
    const row = this.row(id);
    if (!row) throw new Error("signing_request_not_found");
    return `signing/${row.owner_id}/${row.repository_id}/${id}/${row.current_stage}.zip`;
  }

  bindOutputUpload(id: string, context: SigningMachineContext, uploadId: string) {
    this.machine(id, context, "output-upload");
    if (!uploadId || uploadId === "pending") throw new Error("signing_output_invalid");
    this.ctx.storage.sql.exec(
      "UPDATE signing_uploads SET upload_id=? WHERE request_id=? AND upload_id='pending'",
      uploadId,
      id
    );
    const upload = this.outputUpload(id);
    if (!upload) throw new Error("signing_output_invalid");
    return { key: this.outputKey(id), uploadId: upload.upload_id };
  }

  authorizeOutputPart(id: string, context: SigningMachineContext, part: number, length: number) {
    this.machine(id, context, "output-upload");
    const upload = this.outputUpload(id);
    if (!upload || upload.verified || upload.upload_id === "pending")
      throw new Error("signing_output_invalid");
    if (!Number.isInteger(part) || part < 1 || part > upload.part_count)
      throw new Error("signing_part_invalid");
    const expected =
      part < upload.part_count
        ? upload.part_size
        : upload.size - (upload.part_count - 1) * upload.part_size;
    if (length !== expected) throw new Error("signing_part_invalid");
    return { key: this.outputKey(id), uploadId: upload.upload_id, expected, total: upload.size };
  }

  recordOutputPart(
    id: string,
    context: SigningMachineContext,
    part: number,
    etag: string,
    size: number
  ) {
    this.authorizeOutputPart(id, context, part, size);
    this.ctx.storage.sql.exec(
      "INSERT INTO signing_upload_parts(request_id,part,etag,size) VALUES (?,?,?,?) ON CONFLICT(request_id,part) DO UPDATE SET etag=excluded.etag,size=excluded.size",
      id,
      part,
      etag,
      size
    );
    return {
      part,
      receivedParts: this.ctx.storage.sql
        .exec<{ part: number }>(
          "SELECT part FROM signing_upload_parts WHERE request_id=? ORDER BY part",
          id
        )
        .toArray()
        .map((value) => value.part),
    };
  }

  outputCompletionPlan(id: string, context: SigningMachineContext) {
    this.machine(id, context, "output-complete");
    const upload = this.outputUpload(id);
    if (!upload || upload.upload_id === "pending") throw new Error("signing_output_invalid");
    const partRows = this.ctx.storage.sql
      .exec<{ part: number; etag: string; size: number }>(
        "SELECT part,etag,size FROM signing_upload_parts WHERE request_id=? ORDER BY part",
        id
      )
      .toArray();
    if (
      !upload.verified &&
      (partRows.length !== upload.part_count ||
        partRows.some((value, index) => {
          const expected =
            index + 1 < upload.part_count
              ? upload.part_size
              : upload.size - (upload.part_count - 1) * upload.part_size;
          return value.part !== index + 1 || value.size !== expected;
        }))
    )
      throw new Error("signing_parts_incomplete");
    return {
      key: this.outputKey(id),
      uploadId: upload.upload_id,
      digest: upload.digest,
      size: upload.size,
      verified: Boolean(upload.verified),
      parts: partRows.map((value) => ({ partNumber: value.part, etag: value.etag })),
    };
  }

  recordVerifiedOutput(id: string, context: SigningMachineContext, digest: string, size: number) {
    this.machine(id, context, "output-verified");
    const upload = this.outputUpload(id);
    if (!upload || upload.digest !== digest || upload.size !== size)
      throw new Error("signing_output_invalid");
    this.ctx.storage.sql.exec(
      "UPDATE signing_uploads SET verified=1 WHERE request_id=? AND digest=? AND size=?",
      id,
      digest,
      size
    );
    return { digest, size, verified: true as const };
  }

  private retryDetails(
    id: string,
    ownerId: string,
    repositoryId: string
  ): SigningRetryDetails | null {
    const row = this.expire(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return null;
    const previous = previousStage(row.current_stage);
    const output = previous
      ? this.ctx.storage.sql
          .exec<{ digest: string; size: number }>(
            "SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?",
            id,
            previous
          )
          .toArray()[0]
      : { digest: row.source_digest, size: row.source_size };
    if (!output) return null;
    return {
      request: this.public(row),
      dispatch: SigningReconcileDispatchSchema.parse({
        ...this.dispatch(row),
        stage: row.current_stage,
        inputDigest: output.digest,
        inputSize: output.size,
        previousVerification: this.previousVerification(row),
      }),
    };
  }

  retrySnapshot(id: string, ownerId: string, repositoryId: string): SigningRetrySnapshot | null {
    const details = this.retryDetails(id, ownerId, repositoryId);
    return details
      ? { request: details.request, dispatchJson: JSON.stringify(details.dispatch) }
      : null;
  }

  findSource(repositoryId: string, ownerId: string, revision: string, submissionJson: string) {
    const row = this.ctx.storage.sql
      .exec<{ id: string; idempotency_key: string }>(
        "SELECT id,idempotency_key FROM signing_requests WHERE repository_id=? AND owner_id=? AND json_extract(profile_json,'$.revision')=? AND submission_json=? LIMIT 1",
        repositoryId,
        ownerId,
        revision,
        JSON.stringify(SigningSubmissionSchema.parse(JSON.parse(submissionJson)))
      )
      .toArray()[0];
    const request = row ? this.get(row.id, ownerId, repositoryId) : null;
    return row && request ? { request, idempotencyKey: row.idempotency_key } : null;
  }

  retryStage(
    id: string,
    ownerId: string,
    repositoryId: string,
    failedRunId: string | null,
    failedGeneration: number
  ): SigningRetryResult {
    const row = this.row(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId)
      return { status: "not_found" };
    if (row.expires_at <= Date.now()) return { status: "expired" };
    const snapshot = this.retrySnapshot(id, ownerId, repositoryId);
    if (!snapshot) return { status: "conflict" };
    if (
      row.generation === failedGeneration + 1 &&
      row.run_id &&
      ["queued", "running", "succeeded", "awaiting_source"].includes(row.state)
    )
      return { status: "ready", snapshot, upload: null };
    if (row.state !== "failed" || row.run_id !== failedRunId || row.generation !== failedGeneration)
      return { status: "conflict" };
    const upload = this.expiredUpload(id, ownerId, repositoryId);
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='queued',run_id=?,generation=generation+1,nonce=?,output_digest=NULL,output_size=NULL,authorized_at=0,verification_json=NULL,completed_at=NULL WHERE id=?",
        crypto.randomUUID(),
        nonce,
        id
      );
      this.ctx.storage.sql.exec("DELETE FROM signing_upload_parts WHERE request_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM signing_uploads WHERE request_id=?", id);
      this.ctx.storage.sql.exec(
        "DELETE FROM signing_stage_outputs WHERE request_id=? AND stage=?",
        id,
        row.current_stage
      );
    });
    const current = this.retrySnapshot(id, ownerId, repositoryId);
    return current ? { status: "ready", snapshot: current, upload } : { status: "conflict" };
  }

  bindRun(id: string, ownerId: string, repositoryId: string, runId: string): boolean {
    const row = this.row(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return false;
    if (row.run_id && row.run_id !== runId) throw new Error("signing_run_conflict");
    this.ctx.storage.sql.exec(
      "UPDATE signing_requests SET run_id=?,state='queued' WHERE id=? AND owner_id=? AND repository_id=? AND state IN ('accepted','queued')",
      runId,
      id,
      ownerId,
      repositoryId
    );
    return true;
  }

  prepareNextStage(id: string, ownerId: string, repositoryId: string, nonce: string) {
    const row = this.expire(id);
    if (!row || row.owner_id !== ownerId || row.repository_id !== repositoryId) return null;
    if (row.state === "accepted" && !row.run_id) {
      const previous = previousStage(row.current_stage);
      const output = previous
        ? this.ctx.storage.sql
            .exec<{ digest: string; size: number }>(
              "SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?",
              id,
              previous
            )
            .toArray()[0]
        : null;
      if (!output) return { request: this.public(row), dispatch: null };
      return {
        request: this.public(row),
        dispatch: {
          ...this.dispatch(row),
          stage: row.current_stage,
          inputDigest: output.digest,
          inputSize: output.size,
          previousVerification: this.previousVerification(row),
        },
      };
    }
    if (row.state !== "awaiting_source") return { request: this.public(row), dispatch: null };
    const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
    const next = nextStage(row.current_stage, profile.policy.project?.macos?.output_format);
    if (!next) return { request: this.public(row), dispatch: null };
    const output = this.ctx.storage.sql
      .exec<{ digest: string; size: number }>(
        "SELECT digest,size FROM signing_stage_outputs WHERE request_id=? AND stage=?",
        id,
        row.current_stage
      )
      .toArray()[0];
    if (!output) throw new Error("signing_stage_output_unavailable");
    const advanced = this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec(
        "UPDATE signing_requests SET state='accepted',current_stage=?,run_id=NULL,output_digest=NULL,output_size=NULL,authorized_at=0,verification_json=NULL,generation=generation+1,nonce=? WHERE id=? AND state='awaiting_source' AND current_stage=?",
        next,
        nonce,
        id,
        row.current_stage
      ).rowsWritten;
      if (changed) {
        this.ctx.storage.sql.exec("DELETE FROM signing_upload_parts WHERE request_id=?", id);
        this.ctx.storage.sql.exec("DELETE FROM signing_uploads WHERE request_id=?", id);
      }
      return changed > 0;
    });
    const current = this.row(id)!;
    return {
      request: this.public(current),
      dispatch: advanced
        ? {
            ...this.dispatch(current),
            stage: next,
            inputDigest: output.digest,
            inputSize: output.size,
            previousVerification: this.previousVerification(current),
          }
        : null,
    };
  }

  failRun(
    id: string,
    ownerId: string,
    repositoryId: string,
    runId: string,
    conclusion: string
  ): boolean {
    const row = this.row(id);
    if (
      !row ||
      row.owner_id !== ownerId ||
      row.repository_id !== repositoryId ||
      row.run_id !== runId
    )
      return false;
    if (["succeeded", "failed", "cancelled"].includes(row.state)) return true;
    const state = conclusion === "cancelled" ? "cancelled" : "failed";
    this.ctx.storage.sql.exec(
      "UPDATE signing_requests SET state=?,completed_at=? WHERE id=? AND owner_id=? AND repository_id=? AND run_id=? AND state IN ('queued','running','accepted')",
      state,
      Date.now(),
      id,
      ownerId,
      repositoryId,
      runId
    );
    return this.row(id)?.state === state;
  }

  failNotarization(id: string, ownerId: string, repositoryId: string): boolean {
    const row = this.row(id);
    if (
      !row ||
      row.owner_id !== ownerId ||
      row.repository_id !== repositoryId ||
      row.state !== "accepted"
    )
      return false;
    this.ctx.storage.sql.exec(
      "UPDATE signing_requests SET state='failed',completed_at=? WHERE id=? AND state='accepted'",
      Date.now(),
      id
    );
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && parts[0] === "create") {
      try {
        return Response.json(await this.create(await readJsonLimited(request, 131_072)));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "signing_create_invalid" },
          { status: 400 }
        );
      }
    }
    if (request.method === "GET" && parts[0] === "requests" && parts[1]) {
      const ownerId = request.headers.get("X-Signing-Owner") ?? "";
      const repositoryId = request.headers.get("X-Signing-Repository") ?? "";
      const requestData = this.get(parts[1], ownerId, repositoryId);
      return requestData
        ? Response.json({ request: requestData })
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "POST" && parts[0] === "bind-run" && parts[1]) {
      try {
        const body = z
          .object({ ownerId: z.string().min(1), repositoryId: z.string().min(1), runId: z.uuid() })
          .strict()
          .parse(await readJsonLimited(request, 4096));
        return Response.json({
          bound: this.bindRun(parts[1], body.ownerId, body.repositoryId, body.runId),
        });
      } catch {
        return Response.json({ error: "signing_binding_invalid" }, { status: 400 });
      }
    }
    if (request.method === "POST" && parts[0] === "prepare-next-stage" && parts[1]) {
      try {
        const body = z
          .object({
            ownerId: z.string().min(1),
            repositoryId: z.string().min(1),
            nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          })
          .strict()
          .parse(await readJsonLimited(request, 4096));
        return Response.json({
          data: this.prepareNextStage(parts[1], body.ownerId, body.repositoryId, body.nonce),
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "signing_stage_error" },
          { status: 409 }
        );
      }
    }
    if (request.method === "GET" && parts[0] === "expired-upload" && parts[1]) {
      const ownerId = request.headers.get("X-Signing-Owner") ?? "";
      const repositoryId = request.headers.get("X-Signing-Repository") ?? "";
      return Response.json({ upload: this.expiredUpload(parts[1], ownerId, repositoryId) });
    }
    if (request.method === "POST" && parts[0] === "fail-run" && parts[1]) {
      try {
        const body = z
          .object({
            ownerId: z.string().min(1),
            repositoryId: z.string().min(1),
            runId: z.uuid(),
            conclusion: z.string().min(1).max(64),
          })
          .strict()
          .parse(await readJsonLimited(request, 4096));
        return Response.json({
          failed: this.failRun(
            parts[1],
            body.ownerId,
            body.repositoryId,
            body.runId,
            body.conclusion
          ),
        });
      } catch {
        return Response.json({ error: "signing_run_failure_invalid" }, { status: 400 });
      }
    }
    if (request.method === "POST" && parts[0] === "fail-source" && parts[1]) {
      try {
        const body = z
          .object({ ownerId: z.string().min(1), repositoryId: z.string().min(1) })
          .strict()
          .parse(await readJsonLimited(request, 4096));
        return Response.json({
          failed: this.failNotarization(parts[1], body.ownerId, body.repositoryId),
        });
      } catch {
        return Response.json({ error: "signing_source_failure_invalid" }, { status: 400 });
      }
    }
    if (request.method === "POST" && parts[0] === "fail-notarization" && parts[1]) {
      try {
        const body = z
          .object({ ownerId: z.string().min(1), repositoryId: z.string().min(1) })
          .strict()
          .parse(await readJsonLimited(request, 4096));
        return Response.json({
          failed: this.failNotarization(parts[1], body.ownerId, body.repositoryId),
        });
      } catch {
        return Response.json({ error: "signing_notary_failure_invalid" }, { status: 400 });
      }
    }
    if (request.method === "POST" && parts[0] === "machine" && parts[1] && parts[2]) {
      try {
        const body = z
          .object({
            context: SigningMachineContextSchema,
            payload: z.record(z.string(), z.unknown()).optional(),
          })
          .strict()
          .parse(await readJsonLimited(request, 262_144));
        if (parts[2] === "output-begin")
          return Response.json({
            data: await this.beginOutput(
              parts[1],
              body.context,
              String(body.payload?.digest),
              Number(body.payload?.size)
            ),
          });
        if (parts[2] === "output-part")
          return Response.json({
            data: this.authorizeOutputPart(
              parts[1],
              body.context,
              Number(body.payload?.part),
              Number(body.payload?.length)
            ),
          });
        if (parts[2] === "output-record")
          return Response.json({
            data: this.recordOutputPart(
              parts[1],
              body.context,
              Number(body.payload?.part),
              String(body.payload?.etag),
              Number(body.payload?.size)
            ),
          });
        if (parts[2] === "output-bind")
          return Response.json({
            data: this.bindOutputUpload(parts[1], body.context, String(body.payload?.uploadId)),
          });
        if (parts[2] === "output-complete")
          return Response.json({ data: this.outputCompletionPlan(parts[1], body.context) });
        if (parts[2] === "output-verified")
          return Response.json({
            data: this.recordVerifiedOutput(
              parts[1],
              body.context,
              String(body.payload?.digest),
              Number(body.payload?.size)
            ),
          });
        return Response.json({
          data: this.machine(parts[1], body.context, parts[2], body.payload),
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "signing_machine_error" },
          { status: 409 }
        );
      }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

function containsCredentialMaterial(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  const blocked =
    /^(?:secret|secrets|credential|credentials|password|private_?key|certificate_p12|certificate_password|access_?token|api_?key)$/i;
  return Object.entries(value).some(
    ([key, child]) => blocked.test(key) || containsCredentialMaterial(child)
  );
}

export function previousStage(stage: string): string | null {
  if (stage === "finalize") return "sign";
  if (stage === "dmg_sign") return "finalize";
  if (stage === "dmg_finalize") return "dmg_sign";
  return null;
}

function nextStage(stage: string, outputFormat?: string): string | null {
  if (stage === "sign") return "finalize";
  if (stage === "finalize" && outputFormat === "dmg") return "dmg_sign";
  if (stage === "dmg_sign") return "dmg_finalize";
  return null;
}

export function coordinator(env: SigningEnv, ownerId: string) {
  return env.SIGNING_COORDINATORS.getByName(ownerId);
}

export async function queueSigningRequest(
  profile: {
    revision: string;
    workflowOid: string;
    workflowPath: string;
    workflowSource: string;
    platform: "windows" | "macos" | "ios";
    timeoutMinutes: number;
    policy: Record<string, unknown>;
  },
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
  };
  return hooks.enqueue(input);
}
