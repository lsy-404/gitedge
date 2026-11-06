import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";

const limits = { runner: 128, repository: 512, scope: 256, key: 512, version: 128 };
const maxBlocks = 50_000;
const maxLearnedKeys = 20_000;
const maxEntries = 10_000;
const maxBlockRecords = 1_000_000;
const decayPeriod = 7 * 24 * 60 * 60 * 1000;
const ownerMarker = "gitedge-runner-cache-v1\n";

function boundedString(value, name, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Error(`Invalid ${name}.`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
  return value;
}

function identifier(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new Error("Invalid cache entry id.");
  return value;
}

function eventKey(runner, repository, scope, key) {
  return JSON.stringify([runner, repository, scope, key]);
}

function frequency(count, updatedAt, now = Date.now()) {
  return Math.min(
    1_000_000,
    Math.max(0, count * 2 ** (-Math.max(0, now - updatedAt) / decayPeriod))
  );
}

function streamFile(filePath, start, end) {
  return createReadStream(filePath, { start, end });
}

async function drain(readable) {
  for await (const _chunk of readable) {
  }
}

export async function openRunnerCacheStore({ directory, maxBytes }) {
  if (typeof directory !== "string" || !directory) throw new Error("Invalid cache directory.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid cache capacity.");
  const root = path.resolve(directory);
  const headroom = Math.min(1024 ** 3, Math.floor(maxBytes / 20));
  const payloadMaxBytes = maxBytes - headroom;
  let rootExists = true;
  try {
    await lstat(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    rootExists = false;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Cache root must be a real directory.");
  if (!rootExists) await chmod(root, 0o700);
  if (process.platform !== "win32" && (rootInfo.mode & 0o077) !== 0)
    throw new Error("Cache root permissions must be private.");
  const markerPath = path.join(root, ".gitedge-runner-cache");
  let markerInitiallyPresent = true;
  try {
    const markerInfo = await lstat(markerPath);
    if (
      !markerInfo.isFile() ||
      markerInfo.isSymbolicLink() ||
      (await readFile(markerPath, "utf8")) !== ownerMarker
    )
      throw new Error("Cache root is not owned by the runner cache store.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    markerInitiallyPresent = false;
  }
  if (rootExists && !markerInitiallyPresent && (await readdir(root)).length > 0)
    throw new Error("Cache root is not an empty directory or an owned cache directory.");
  const releaseLock = await lockfile.lock(root, { realpath: false, stale: 30_000, update: 10_000 });
  let database;
  try {
    let markerExists = true;
    try {
      await lstat(markerPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      markerExists = false;
    }
    if (rootExists && !markerExists && (await readdir(root)).length > 0)
      throw new Error("Cache root is not an empty directory or an owned cache directory.");
    try {
      const marker = await open(markerPath, "wx", 0o600);
      try {
        await marker.writeFile(ownerMarker);
        await marker.sync();
      } finally {
        await marker.close();
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const markerInfo = await lstat(markerPath);
      if (
        !markerInfo.isFile() ||
        markerInfo.isSymbolicLink() ||
        (await readFile(markerPath, "utf8")) !== ownerMarker
      )
        throw new Error("Cache root is not owned by the runner cache store.");
    }
    const entriesPath = path.join(root, "entries");
    const uploadsPath = path.join(root, "uploads");
    for (const folder of [entriesPath, uploadsPath]) {
      try {
        await mkdir(folder, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Cache data paths must be real directories.");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        throw new Error("Cache data directory permissions must be private.");
    }
    const metadataPath = path.join(root, "metadata.sqlite");
    try {
      const metadataInfo = await lstat(metadataPath);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink())
        throw new Error("Cache metadata must be a regular file.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    database = new DatabaseSync(metadataPath);
    await chmod(metadataPath, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA wal_autocheckpoint = 1000;
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, runner TEXT NOT NULL, repository TEXT NOT NULL, scope TEXT NOT NULL,
        cache_key TEXT NOT NULL, version TEXT NOT NULL, expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 1, frequency_at INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS entries_identity ON entries(runner, repository, scope, cache_key, version, status);
      CREATE TABLE IF NOT EXISTS blocks (
        entry_id TEXT NOT NULL, position INTEGER NOT NULL, block_id TEXT NOT NULL,
        file_name TEXT NOT NULL, bytes INTEGER NOT NULL,
        PRIMARY KEY(entry_id, position), UNIQUE(entry_id, block_id)
      );
      CREATE TABLE IF NOT EXISTS learned (
        identity TEXT PRIMARY KEY, runner TEXT NOT NULL, repository TEXT NOT NULL, scope TEXT NOT NULL,
        cache_key TEXT NOT NULL, count INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS learned_updated ON learned(updated_at);
    `);
    database
      .prepare("UPDATE entries SET expires_at = ? WHERE status = 'ready'")
      .run(Number.MAX_SAFE_INTEGER);

    const staleUploads = database.prepare("SELECT id FROM entries WHERE status != 'ready'").all();
    for (const row of staleUploads) {
      cacheId(row.id);
      await rm(path.join(uploadsPath, row.id), { recursive: true, force: true });
      await rm(path.join(entriesPath, row.id), { recursive: true, force: true });
    }
    database.exec(
      "DELETE FROM blocks WHERE entry_id IN (SELECT id FROM entries WHERE status != 'ready'); DELETE FROM entries WHERE status != 'ready';"
    );

    const readyRows = database.prepare("SELECT id FROM entries WHERE status = 'ready'").all();
    const known = new Set(readyRows.map((row) => row.id));
    for (const name of await readdir(uploadsPath)) {
      await rm(path.join(uploadsPath, name), { recursive: true, force: true });
    }
    for (const name of await readdir(entriesPath)) {
      if (!known.has(name))
        await rm(path.join(entriesPath, name), { recursive: true, force: true });
    }

    const db = database;
    const activeReads = new Map();
    const activeWrites = new Map();
    const lifecycleOps = new Set();
    let blockRecordReservations = 0;
    let pendingCreates = 0;
    let closed = false;
    let capacityTail = Promise.resolve();
    const withCapacityLock = async (operation) => {
      const previous = capacityTail;
      let release;
      capacityTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (closed) throw new Error("Cache store is closed.");
        return await operation();
      } finally {
        release();
      }
    };
    const sum = (where = "1 = 1", args = []) =>
      db
        .prepare(`SELECT COALESCE(SUM(bytes), 0) AS amount FROM entries WHERE ${where}`)
        .get(...args).amount;
    const usedBytes = () => sum("status = 'ready'");
    const reservedBytes = () => sum("status != 'ready'");
    const totalBytes = () => usedBytes() + reservedBytes();
    const candidateRank = (row, now) => [
      Math.floor(frequency(row.hits, row.frequency_at, now)),
      row.bytes,
      row.accessed_at,
    ];
    const compareRank = (left, right) => {
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
      }
      return 0;
    };
    const evictionCounts = new Map();
    const recordEviction = (runner) => {
      evictionCounts.set(runner, (evictionCounts.get(runner) ?? 0) + 1);
    };
    const removeEntryFiles = async (entry) => {
      cacheId(entry.id);
      db.prepare("UPDATE entries SET status = 'evicting' WHERE id = ?").run(entry.id);
      try {
        await rm(path.join(uploadsPath, entry.id), { recursive: true, force: true });
        await rm(path.join(entriesPath, entry.id), { recursive: true, force: true });
      } catch (error) {
        db.prepare("UPDATE entries SET status = ? WHERE id = ?").run(entry.status, entry.id);
        throw error;
      }
      db.prepare("DELETE FROM blocks WHERE entry_id = ?").run(entry.id);
      db.prepare("DELETE FROM entries WHERE id = ?").run(entry.id);
    };
    const purgeExpired = async () => {
      const expired = db
        .prepare("SELECT id, runner, status FROM entries WHERE expires_at <= ?")
        .all(Date.now());
      for (const row of expired) {
        cacheId(row.id);
        if (activeReads.has(row.id) || activeWrites.has(row.id)) continue;
        await removeEntryFiles(row);
      }
    };
    const evictOne = async (incomingRank) => {
      const now = Date.now();
      const candidates = db
        .prepare("SELECT * FROM entries WHERE status = 'ready'")
        .all()
        .filter((row) => !activeReads.has(row.id))
        .sort((left, right) => compareRank(candidateRank(left, now), candidateRank(right, now)));
      const candidate = candidates[0];
      if (!candidate || compareRank(candidateRank(candidate, now), incomingRank) > 0) return false;
      await removeEntryFiles(candidate);
      evictions += 1;
      recordEviction(candidate.runner);
      return true;
    };
    let evictions = 0;
    const makeRoom = async (additionalBytes, incomingRank) => {
      await purgeExpired();
      if (totalBytes() + additionalBytes <= payloadMaxBytes) return true;
      const now = Date.now();
      const candidates = db
        .prepare("SELECT * FROM entries WHERE status = 'ready'")
        .all()
        .filter(
          (row) =>
            !activeReads.has(row.id) && compareRank(candidateRank(row, now), incomingRank) <= 0
        )
        .sort((left, right) => compareRank(candidateRank(left, now), candidateRank(right, now)));
      let reclaimable = 0;
      for (const candidate of candidates) reclaimable += candidate.bytes;
      if (totalBytes() + additionalBytes - reclaimable > payloadMaxBytes) return false;
      for (const candidate of candidates)
        db.prepare("UPDATE entries SET status = 'evicting' WHERE id = ?").run(candidate.id);
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (totalBytes() + additionalBytes <= payloadMaxBytes) {
          for (const remaining of candidates.slice(index))
            db.prepare("UPDATE entries SET status = 'ready' WHERE id = ?").run(remaining.id);
          break;
        }
        try {
          await removeEntryFiles(candidate);
        } catch (error) {
          for (const remaining of candidates.slice(index + 1))
            db.prepare("UPDATE entries SET status = 'ready' WHERE id = ?").run(remaining.id);
          throw error;
        }
        evictions += 1;
        recordEviction(candidate.runner);
      }
      return true;
    };
    const cleanupDiscarded = async (id) => {
      if (activeWrites.has(id)) return;
      await rm(path.join(uploadsPath, id), { recursive: true, force: true });
      await rm(path.join(entriesPath, id), { recursive: true, force: true });
      db.prepare("DELETE FROM blocks WHERE entry_id = ?").run(id);
      db.prepare("UPDATE entries SET bytes = 0 WHERE id = ? AND status = 'discarded'").run(id);
    };
    const markDiscardedLocked = async (id) => {
      db.prepare("UPDATE entries SET status = 'discarded', committed = 0 WHERE id = ?").run(id);
      await cleanupDiscarded(id);
    };
    const markDiscarded = (id) => withCapacityLock(() => markDiscardedLocked(id));
    const finishWrite = (id, blockId) =>
      withCapacityLock(async () => {
        const active = activeWrites.get(id);
        active?.delete(blockId);
        if (active?.size === 0) activeWrites.delete(id);
        const row = db.prepare("SELECT status, expires_at FROM entries WHERE id = ?").get(id);
        if (!row) return;
        if (row.status === "discarded") {
          await cleanupDiscarded(id);
          if (row.expires_at <= Date.now()) db.prepare("DELETE FROM entries WHERE id = ?").run(id);
        } else if (row.status !== "ready" && row.expires_at <= Date.now()) {
          await removeEntryFiles(row);
        }
      });
    const assertOpen = () => {
      if (closed) throw new Error("Cache store is closed.");
    };
    const learn = (runner, repository, scope, key, increment = 1) => {
      const identity = eventKey(runner, repository, scope, key);
      const hash = identifier(identity);
      const now = Date.now();
      const existing = db
        .prepare("SELECT count, updated_at FROM learned WHERE identity = ?")
        .get(hash);
      const nextCount = Math.min(
        1_000_000,
        frequency(existing?.count ?? 0, existing?.updated_at ?? now, now) + increment
      );
      db.prepare(
        `INSERT INTO learned(identity, runner, repository, scope, cache_key, count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity) DO UPDATE SET
        count = excluded.count, updated_at = excluded.updated_at`
      ).run(hash, runner, repository, scope, key, nextCount, now);
      db.prepare(
        `DELETE FROM learned WHERE identity IN (
        SELECT identity FROM learned ORDER BY updated_at DESC LIMIT -1 OFFSET ?
      )`
      ).run(maxLearnedKeys);
      return nextCount;
    };
    const learnedCount = (runner, repository, scope, key) => {
      const row = db
        .prepare("SELECT count, updated_at FROM learned WHERE identity = ?")
        .get(identifier(eventKey(runner, repository, scope, key)));
      return frequency(row?.count ?? 0, row?.updated_at ?? Date.now());
    };
    const blockFileName = (blockId) => `${identifier(blockId)}.part`;

    const store = {
      async create({ runner, repository, scope, key, version, expiresAt }) {
        assertOpen();
        runner = boundedString(runner, "runner", limits.runner);
        repository = boundedString(repository, "repository", limits.repository);
        scope = boundedString(scope, "scope", limits.scope);
        key = boundedString(key, "key", limits.key);
        version = boundedString(version, "version", limits.version);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
          throw new Error("Invalid expiry.");
        const id = randomUUID();
        const now = Date.now();
        const hits = Math.max(1, learnedCount(runner, repository, scope, key));
        pendingCreates += 1;
        try {
          await withCapacityLock(async () => {
            await purgeExpired();
            const collision = db
              .prepare(
                `SELECT id FROM entries WHERE runner = ? AND repository = ? AND scope = ?
                  AND cache_key = ? AND version = ? LIMIT 1`
              )
              .get(runner, repository, scope, key, version);
            if (collision)
              throw new Error("A cache entry or upload already exists for this key and version.");
            const entryCount = db.prepare("SELECT COUNT(*) AS amount FROM entries").get().amount;
            if (entryCount >= maxEntries) {
              const now = Date.now();
              const rank = (row) => [
                Math.floor(frequency(row.hits, row.frequency_at, now)),
                row.accessed_at,
              ];
              const candidate = db
                .prepare("SELECT * FROM entries WHERE status = 'ready'")
                .all()
                .filter((row) => !activeReads.has(row.id))
                .sort((left, right) => compareRank(rank(left), rank(right)))[0];
              if (!candidate || compareRank(rank(candidate), [Math.floor(hits), now]) > 0)
                throw new Error("Cache metadata capacity is full.");
              cacheId(candidate.id);
              await removeEntryFiles(candidate);
              evictions += 1;
              recordEviction(candidate.runner);
            }
            db.prepare(
              `INSERT INTO entries(id, runner, repository, scope, cache_key, version, expires_at,
                created_at, accessed_at, hits, frequency_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`
            ).run(id, runner, repository, scope, key, version, expiresAt, now, now, hits, now);
          });
          await mkdir(path.join(uploadsPath, id), { mode: 0o700 });
          return { id };
        } catch (error) {
          await withCapacityLock(() => db.prepare("DELETE FROM entries WHERE id = ?").run(id));
          throw error;
        } finally {
          pendingCreates -= 1;
        }
      },

      async putBlock(id, blockId, readable, length) {
        assertOpen();
        cacheId(id);
        boundedString(blockId, "block id", 128);
        positiveInteger(length, "block length");
        if (!readable || typeof readable[Symbol.asyncIterator] !== "function")
          throw new Error("Block body must be a readable stream.");
        const admission = await withCapacityLock(async () => {
          await purgeExpired();
          const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(id);
          if (!entry || !["uploading", "discarded"].includes(entry.status))
            throw new Error("Cache upload does not exist.");
          if (entry.status === "discarded") return null;
          if (lifecycleOps.has(id) || entry.committed)
            throw new Error("Cache upload is already being committed.");
          const active = activeWrites.get(id);
          if (active?.has(blockId)) throw new Error("This cache block is already being uploaded.");
          const oldBlock = db
            .prepare("SELECT bytes FROM blocks WHERE entry_id = ? AND block_id = ?")
            .get(id, blockId);
          const existingBlockCount = db
            .prepare("SELECT COUNT(*) AS amount FROM blocks WHERE entry_id = ?")
            .get(id).amount;
          if (!oldBlock && existingBlockCount >= maxBlocks) {
            await markDiscardedLocked(id);
            return null;
          }
          if (
            !oldBlock &&
            db.prepare("SELECT COUNT(*) AS amount FROM blocks").get().amount +
              blockRecordReservations >=
              maxBlockRecords
          ) {
            await markDiscardedLocked(id);
            return null;
          }
          const incomingRank = [
            Math.floor(frequency(entry.hits, entry.frequency_at)),
            entry.bytes + length,
            Date.now(),
          ];
          if (!(await makeRoom(length, incomingRank))) {
            await markDiscardedLocked(id);
            return null;
          }
          db.prepare("UPDATE entries SET bytes = bytes + ? WHERE id = ?").run(length, id);
          if (!active) activeWrites.set(id, new Set([blockId]));
          else active.add(blockId);
          if (!oldBlock) blockRecordReservations += 1;
          return { oldBlock, reservesBlockRecord: !oldBlock };
        });
        if (!admission) {
          await drain(readable);
          return;
        }
        const partialName = `${blockFileName(blockId)}.${randomUUID()}.partial`;
        const partialPath = path.join(uploadsPath, id, partialName);
        const finalName = blockFileName(blockId);
        const finalPath = path.join(uploadsPath, id, finalName);
        let file;
        let observed = 0;
        let writeFailed = false;
        let readingStarted = false;
        try {
          file = await open(partialPath, "wx", 0o600);
          readingStarted = true;
          for await (const chunk of readable) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            observed += buffer.byteLength;
            if (observed > length) throw new Error("Block body exceeded its declared length.");
            if (!writeFailed) {
              let offset = 0;
              while (offset < buffer.byteLength) {
                try {
                  const result = await file.write(buffer, offset, buffer.byteLength - offset);
                  if (result.bytesWritten < 1)
                    throw new Error("Cache block write made no progress.");
                  offset += result.bytesWritten;
                } catch (error) {
                  if (!["ENOSPC", "EDQUOT"].includes(error?.code)) throw error;
                  writeFailed = true;
                  break;
                }
              }
            }
          }
          if (observed !== length) throw new Error("Block body did not match its declared length.");
          if (writeFailed) await markDiscarded(id);
          else
            await withCapacityLock(async () => {
              const current = db.prepare("SELECT status FROM entries WHERE id = ?").get(id);
              if (current?.status !== "uploading") return;
              await file.sync();
              await file.close();
              file = undefined;
              await rename(partialPath, finalPath);
              const position = admission.oldBlock
                ? db
                    .prepare("SELECT position FROM blocks WHERE entry_id = ? AND block_id = ?")
                    .get(id, blockId).position
                : db
                    .prepare(
                      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM blocks WHERE entry_id = ?"
                    )
                    .get(id).position;
              db.prepare(
                `INSERT INTO blocks(entry_id, position, block_id, file_name, bytes)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(entry_id, block_id) DO UPDATE SET file_name = excluded.file_name,
                    bytes = excluded.bytes`
              ).run(id, position, blockId, finalName, length);
              if (admission.oldBlock)
                db.prepare("UPDATE entries SET bytes = bytes - ? WHERE id = ?").run(
                  admission.oldBlock.bytes,
                  id
                );
            });
        } catch (error) {
          if (["ENOSPC", "EDQUOT"].includes(error?.code)) {
            await markDiscarded(id);
            if (!readingStarted) await drain(readable);
            return;
          }
          await markDiscarded(id);
          throw error;
        } finally {
          if (file) await file.close().catch(() => {});
          await rm(partialPath, { force: true });
          if (admission.reservesBlockRecord) blockRecordReservations -= 1;
          await finishWrite(id, blockId);
        }
      },

      async commit(id, blockIds) {
        assertOpen();
        cacheId(id);
        if (
          !Array.isArray(blockIds) ||
          blockIds.length > maxBlocks ||
          blockIds.some(
            (value) => typeof value !== "string" || value.length < 1 || value.length > 128
          ) ||
          new Set(blockIds).size !== blockIds.length
        )
          throw new Error("Invalid or duplicate committed block list.");
        if (lifecycleOps.has(id))
          throw new Error("Cache entry lifecycle operation is already active.");
        lifecycleOps.add(id);
        try {
          const entry = db.prepare("SELECT status FROM entries WHERE id = ?").get(id);
          if (!entry || !["uploading", "discarded"].includes(entry.status))
            throw new Error("Cache upload does not exist.");
          if (activeWrites.has(id)) throw new Error("Cache blocks are still being uploaded.");
          if (entry.status === "discarded") return;
          const rows = db.prepare("SELECT block_id FROM blocks WHERE entry_id = ?").all(id);
          const allBlockCount = db.prepare("SELECT COUNT(*) AS amount FROM blocks").get().amount;
          if (allBlockCount - rows.length + blockIds.length > maxBlockRecords)
            throw new Error("Cache block metadata capacity is full.");
          const present = new Set(rows.map((row) => row.block_id));
          if (blockIds.some((blockId) => !present.has(blockId)))
            throw new Error("Committed block list references a missing block.");
          const keep = new Set(blockIds);
          const all = db.prepare("SELECT * FROM blocks WHERE entry_id = ?").all(id);
          const remove = all.filter((row) => !keep.has(row.block_id));
          for (const row of remove) {
            await rm(path.join(uploadsPath, id, row.file_name), { force: true });
            db.prepare("DELETE FROM blocks WHERE entry_id = ? AND block_id = ?").run(
              id,
              row.block_id
            );
            db.prepare("UPDATE entries SET bytes = bytes - ? WHERE id = ?").run(row.bytes, id);
          }
          db.exec("BEGIN IMMEDIATE");
          try {
            const update = db.prepare(
              "UPDATE blocks SET position = ? WHERE entry_id = ? AND block_id = ?"
            );
            blockIds.forEach((blockId, position) => update.run(-position - 1, id, blockId));
            blockIds.forEach((blockId, position) => update.run(position, id, blockId));
            db.prepare("UPDATE entries SET committed = 1 WHERE id = ?").run(id);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        } finally {
          lifecycleOps.delete(id);
        }
      },

      async finalize(id, sizeBytes) {
        assertOpen();
        cacheId(id);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
          throw new Error("Invalid final size.");
        if (lifecycleOps.has(id))
          throw new Error("Cache entry lifecycle operation is already active.");
        lifecycleOps.add(id);
        try {
          return await withCapacityLock(async () => {
            await purgeExpired();
            const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(id);
            if (!entry) throw new Error("Cache upload does not exist.");
            if (activeWrites.has(id)) throw new Error("Cache blocks are still being uploaded.");
            if (entry.status === "ready") {
              if (entry.bytes === sizeBytes) return { id, stored: true };
              throw new Error("Finalized cache size does not match.");
            }
            if (entry.status === "discarded") {
              await cleanupDiscarded(id);
              db.prepare("DELETE FROM entries WHERE id = ?").run(id);
              return { id, stored: false };
            }
            if (entry.status !== "uploading" || !entry.committed || entry.bytes !== sizeBytes)
              throw new Error("Cache upload is not committed or its size does not match.");
            const source = path.join(uploadsPath, id);
            const destination = path.join(entriesPath, id);
            await rename(source, destination);
            db.prepare("UPDATE entries SET status = 'ready', expires_at = ? WHERE id = ?").run(
              Number.MAX_SAFE_INTEGER,
              id
            );
            return { id, stored: true };
          });
        } finally {
          lifecycleOps.delete(id);
        }
      },

      async lookup({ runner, repository, scopes, key, version, restoreKeys = [] }) {
        assertOpen();
        runner = boundedString(runner, "runner", limits.runner);
        repository = boundedString(repository, "repository", limits.repository);
        key = boundedString(key, "key", limits.key);
        version = boundedString(version, "version", limits.version);
        if (
          !Array.isArray(scopes) ||
          scopes.length < 1 ||
          scopes.some(
            (item) => typeof item !== "string" || item.length < 1 || item.length > limits.scope
          )
        )
          throw new Error("Invalid cache scopes.");
        if (
          !Array.isArray(restoreKeys) ||
          restoreKeys.some(
            (item) => typeof item !== "string" || item.length < 1 || item.length > limits.key
          )
        )
          throw new Error("Invalid restore keys.");
        const keys = [
          { key, exact: true },
          { key, exact: false },
          ...restoreKeys.map((restoreKey) => ({ key: restoreKey, exact: false })),
        ];
        for (const scope of scopes) {
          for (const candidate of keys) {
            const comparison = candidate.exact
              ? "cache_key = ?"
              : "substr(cache_key, 1, length(?)) = ?";
            const found = db
              .prepare(
                `SELECT * FROM entries WHERE runner = ? AND repository = ? AND
              scope = ? AND version = ? AND status = 'ready' AND expires_at > ? AND ${comparison}
              ORDER BY created_at DESC LIMIT 1`
              )
              .get(
                runner,
                repository,
                scope,
                version,
                Date.now(),
                ...(candidate.exact ? [candidate.key] : [candidate.key, candidate.key])
              );
            if (!found) continue;
            const now = Date.now();
            db.prepare(
              "UPDATE entries SET hits = MIN(1000000, ?), accessed_at = ?, frequency_at = ? WHERE id = ?"
            ).run(frequency(found.hits, found.frequency_at) + 1, now, now, found.id);
            learn(runner, repository, scope, found.cache_key);
            hitsByRunner.set(runner, (hitsByRunner.get(runner) ?? 0) + 1);
            return { id: found.id, key: found.cache_key, bytes: found.bytes };
          }
        }
        missesByRunner.set(runner, (missesByRunner.get(runner) ?? 0) + 1);
        for (const scope of scopes) learn(runner, repository, scope, key);
        return null;
      },

      async read(id, { start = 0, end } = {}) {
        assertOpen();
        cacheId(id);
        const entry = db.prepare("SELECT * FROM entries WHERE id = ? AND status = 'ready'").get(id);
        if (!entry) throw new Error("Cache entry does not exist.");
        db.prepare("UPDATE entries SET accessed_at = ? WHERE id = ?").run(Date.now(), id);
        if (entry.bytes === 0) {
          if (start !== 0 || (end !== undefined && end !== -1))
            throw new Error("Invalid cache range.");
          return {
            stream: Readable.from((async function* empty() {})(), { objectMode: false }),
            bytes: 0,
          };
        }
        if (!Number.isSafeInteger(start) || start < 0 || start >= Math.max(1, entry.bytes))
          throw new Error("Invalid cache range start.");
        end ??= entry.bytes - 1;
        if (!Number.isSafeInteger(end) || end < start || end >= entry.bytes)
          throw new Error("Invalid cache range end.");
        const selected = [];
        const blocks = db
          .prepare("SELECT * FROM blocks WHERE entry_id = ? ORDER BY position")
          .all(id);
        let offset = 0;
        for (const block of blocks) {
          if (block.file_name !== blockFileName(block.block_id))
            throw new Error("Cache block metadata is invalid.");
          const blockEnd = offset + block.bytes - 1;
          if (blockEnd >= start && offset <= end) {
            selected.push({
              path: path.join(entriesPath, id, block.file_name),
              start: Math.max(0, start - offset),
              end: Math.min(block.bytes - 1, end - offset),
            });
          }
          offset += block.bytes;
        }
        activeReads.set(id, (activeReads.get(id) ?? 0) + 1);
        let released = false;
        let currentStream;
        const unpin = () => {
          if (released) return;
          released = true;
          const count = (activeReads.get(id) ?? 1) - 1;
          if (count <= 0) activeReads.delete(id);
          else activeReads.set(id, count);
        };
        async function* chunks() {
          try {
            for (const item of selected) {
              currentStream = streamFile(item.path, item.start, item.end);
              for await (const chunk of currentStream) yield chunk;
              currentStream = undefined;
            }
          } finally {
            currentStream?.destroy();
            unpin();
          }
        }
        const stream = Readable.from(chunks(), { objectMode: false });
        stream.once("close", unpin);
        stream.once("end", unpin);
        return { stream, bytes: end - start + 1 };
      },

      async discard(id) {
        assertOpen();
        cacheId(id);
        if (lifecycleOps.has(id)) throw new Error("Cache entry lifecycle operation is active.");
        lifecycleOps.add(id);
        try {
          await withCapacityLock(async () => {
            const entry = db.prepare("SELECT status FROM entries WHERE id = ?").get(id);
            if (!entry || entry.status === "ready") return;
            if (activeWrites.has(id)) throw new Error("Cannot discard an active cache upload.");
            await markDiscardedLocked(id);
            db.prepare("DELETE FROM entries WHERE id = ?").run(id);
          });
        } finally {
          lifecycleOps.delete(id);
        }
      },

      stats(runner) {
        assertOpen();
        if (runner !== undefined) boundedString(runner, "runner", limits.runner);
        const where = runner === undefined ? "1 = 1" : "runner = ?";
        const args = runner === undefined ? [] : [runner];
        const count = (status) =>
          db
            .prepare(`SELECT COUNT(*) AS amount FROM entries WHERE ${where} AND status = ?`)
            .get(...args, status).amount;
        return {
          maxBytes,
          usedBytes: sum(
            runner === undefined ? "status = 'ready'" : "runner = ? AND status = 'ready'",
            args
          ),
          reservedBytes: sum(
            runner === undefined ? "status != 'ready'" : "runner = ? AND status != 'ready'",
            args
          ),
          entries: count("ready"),
          hits:
            runner === undefined
              ? [...hitsByRunner.values()].reduce((total, value) => total + value, 0)
              : (hitsByRunner.get(runner) ?? 0),
          misses:
            runner === undefined
              ? [...missesByRunner.values()].reduce((total, value) => total + value, 0)
              : (missesByRunner.get(runner) ?? 0),
          evictions: runner === undefined ? evictions : (evictionCounts.get(runner) ?? 0),
        };
      },

      async close() {
        if (closed) return;
        await capacityTail;
        if (activeWrites.size || activeReads.size || lifecycleOps.size || pendingCreates)
          throw new Error("Cache store has active streams.");
        closed = true;
        db.close();
        await releaseLock();
      },
    };
    const hitsByRunner = new Map();
    const missesByRunner = new Map();

    const rows = db
      .prepare("SELECT * FROM entries WHERE status = 'ready' ORDER BY created_at")
      .all();
    for (const row of rows) {
      cacheId(row.id);
      const entryDirectory = path.join(entriesPath, row.id);
      const files = db
        .prepare("SELECT block_id, file_name, bytes FROM blocks WHERE entry_id = ?")
        .all(row.id);
      let valid = files.reduce((total, file) => total + file.bytes, 0) === row.bytes;
      try {
        const info = await lstat(entryDirectory);
        if (!info.isDirectory() || info.isSymbolicLink()) valid = false;
      } catch {
        valid = false;
      }
      for (const file of files) {
        if (file.file_name !== `${identifier(file.block_id)}.part`) valid = false;
        try {
          const info = await lstat(path.join(entryDirectory, file.file_name));
          if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) valid = false;
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        await rm(entryDirectory, { recursive: true, force: true });
        db.prepare("DELETE FROM blocks WHERE entry_id = ?").run(row.id);
        db.prepare("DELETE FROM entries WHERE id = ?").run(row.id);
      }
    }
    await purgeExpired();
    while (usedBytes() > payloadMaxBytes) {
      if (!(await evictOne([Infinity, Infinity, Infinity]))) break;
    }
    return store;
  } catch (error) {
    database?.close();
    await releaseLock();
    throw error;
  }
}
