import WebSocket from "ws";

const maxOutboundBytes = 16 * 1024;
const maxInboundBytes = 2 * 1024 * 1024;
const reportIntervalMs = 30_000;
const pingIntervalMs = 30_000;
const revokedRetryMs = 60_000;
const stableConnectionMs = 60_000;
const maxBackoffMs = 60_000;
const identifier = /^[A-Za-z0-9._:-]{1,100}$/;

export class ProtocolError extends Error {}

export class SupersededError extends Error {}

export function dispatchUrl(origin) {
  const url = new URL("/api/actions/runner/connect", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function reconnectDelay(attempt, random = Math.random) {
  const ceiling = Math.min(maxBackoffMs, 1000 * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isLabel = (value) =>
  typeof value === "string" && value.length <= 100 && !/[\r\n\0]/.test(value);
const isLabels = (value, max) =>
  Array.isArray(value) && value.length <= max && value.every(isLabel);
const isId = (value) => typeof value === "string" && identifier.test(value);
const isJobId = (value) => isId(value) || (Number.isSafeInteger(value) && value > 0);

export function parseServerFrame(data) {
  const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
  if (size > maxInboundBytes) throw new ProtocolError("Frame exceeds the size limit.");
  let frame;
  try {
    frame = JSON.parse(data.toString("utf8"));
  } catch {
    throw new ProtocolError("Frame is not valid JSON.");
  }
  if (!isObject(frame) || typeof frame.type !== "string")
    throw new ProtocolError("Frame has no type.");
  const valid = (() => {
    switch (frame.type) {
      case "ready":
        return isLabels(frame.runnerLabels, 40);
      case "offer":
        return (
          isId(frame.offerId) &&
          ["gitedge", "github"].includes(frame.kind) &&
          isJobId(frame.jobId) &&
          isLabels(frame.labels, 64) &&
          Number.isFinite(frame.expiresAt)
        );
      case "assign":
        return (
          isId(frame.offerId) &&
          isObject(frame.claim) &&
          isObject(frame.claim.run) &&
          ["workflow", "github", "signing"].includes(frame.claim.run.kind) &&
          typeof frame.claim.leaseToken === "string" &&
          frame.claim.leaseToken.length > 0 &&
          Number.isFinite(frame.claim.leaseExpiresAt)
        );
      case "withdraw":
        return (
          isId(frame.offerId) && typeof frame.reason === "string" && frame.reason.length <= 200
        );
      case "error":
        return (
          typeof frame.code === "string" &&
          frame.code.length <= 64 &&
          typeof frame.message === "string" &&
          frame.message.length <= 500
        );
      default:
        throw new ProtocolError(`Unknown frame type ${frame.type.slice(0, 32)}.`);
    }
  })();
  if (!valid) throw new ProtocolError(`Malformed ${frame.type} frame.`);
  return frame;
}

const printable = (value) =>
  String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 200);

const wait = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

// One reconnecting socket. Resolves when `signal` aborts; rejects with SupersededError on close 4003.
export async function runDispatchSocket({
  label,
  origin,
  credential,
  signal,
  buildReport,
  onOpen,
  onClose,
  onFrame,
  log = console,
  createSocket = (url, options) => new WebSocket(url, options),
}) {
  let socket;
  let reports = Promise.resolve();
  const send = (frame) => {
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > maxOutboundBytes) throw new Error("Outbound frame is too large.");
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(text);
    return true;
  };
  const sendReport = () => {
    reports = reports
      .then(async () => {
        if (socket?.readyState === WebSocket.OPEN) send(await buildReport());
      })
      .catch((error) => log.error(`${label}: could not send report: ${printable(error.message)}`));
    return reports;
  };
  const control = { send, sendReport };

  const connect = () =>
    new Promise((resolve) => {
      const ws = createSocket(dispatchUrl(origin), {
        headers: { Authorization: `Bearer ${credential}` },
        maxPayload: maxInboundBytes,
        handshakeTimeout: 20_000,
        followRedirects: false,
        perMessageDeflate: false,
      });
      socket = ws;
      let opened = false;
      let settled = false;
      let alive = true;
      let timers = [];
      const openedAt = { value: 0 };
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearInterval);
        signal.removeEventListener("abort", stop);
        if (socket === ws) socket = undefined;
        if (opened) onClose();
        resolve({ ...outcome, opened, uptime: opened ? Date.now() - openedAt.value : 0 });
      };
      const violation = (message) => {
        log.error(`${label}: protocol violation: ${printable(message)}`);
        ws.close(4002, "protocol violation");
        setTimeout(() => ws.terminate(), 5_000).unref();
      };
      const stop = () => {
        ws.close(1000, "shutdown");
        setTimeout(() => ws.terminate(), 5_000).unref();
      };
      signal.addEventListener("abort", stop, { once: true });
      ws.on("open", () => {
        opened = true;
        openedAt.value = Date.now();
        onOpen(control);
        sendReport();
        timers = [
          setInterval(sendReport, reportIntervalMs),
          setInterval(() => {
            if (!alive) return ws.terminate();
            alive = false;
            ws.ping();
          }, pingIntervalMs),
        ];
      });
      ws.on("pong", () => {
        alive = true;
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return violation("binary frame");
        let frame;
        try {
          frame = parseServerFrame(data);
        } catch (error) {
          return violation(error.message);
        }
        try {
          const result = onFrame(frame, control);
          if (result instanceof Promise)
            result.catch((error) => {
              if (error instanceof ProtocolError) violation(error.message);
              else log.error(`${label}: ${printable(error.message)}`);
            });
        } catch (error) {
          if (error instanceof ProtocolError) violation(error.message);
          else log.error(`${label}: ${printable(error.message)}`);
        }
      });
      ws.on("unexpected-response", (request, response) => {
        response.resume();
        request.destroy();
        settle({ status: response.statusCode });
      });
      ws.on("error", (error) => {
        if (signal.aborted) return;
        if (!opened) log.error(`${label}: connection failed: ${printable(error.message)}`);
        else log.error(`${label}: socket error: ${printable(error.message)}`);
      });
      ws.on("close", (code) => settle({ code }));
    });

  let failures = 0;
  while (!signal.aborted) {
    const outcome = await connect();
    if (signal.aborted) break;
    if (outcome.code === 4003)
      throw new SupersededError(
        `${label}: another broker connected with the same runner credential; stopping.`
      );
    if (outcome.code === 4001 || outcome.status === 401 || outcome.status === 403) {
      log.error(
        `${label}: the runner credential was rejected or revoked; run \`remove\` for this profile if the runner was deleted. Retrying in 60 seconds.`
      );
      await wait(revokedRetryMs, signal);
      continue;
    }
    if (outcome.uptime >= stableConnectionMs) failures = 0;
    const delay = reconnectDelay(failures++);
    log.error(
      `${label}: disconnected (${outcome.code ?? outcome.status ?? "no response"}); reconnecting in ${Math.round(delay / 1000)} seconds.`
    );
    await wait(delay, signal);
  }
}

// Offer handshake and job lifecycle for one profile; the slot and job runner are injected by the broker.
export function createDispatchSession({
  label,
  slot,
  getCapacity,
  validateOffer,
  runJob,
  signal,
  log = console,
}) {
  let current;
  let control; // set while a socket is open
  let handshaking = false;
  const jobs = new Set();

  const releaseOffer = async (offer) => {
    await offer.release?.();
    offer.release = undefined;
    if (current === offer) current = undefined;
  };
  const decline = (offerId, reason) => control?.send({ type: "decline", offerId, reason });

  const handleOffer = async (frame) => {
    if (current) return decline(frame.offerId, "busy");
    const offer = { offerId: frame.offerId, phase: "offering" };
    current = offer;
    handshaking = true;
    try {
      offer.release = await slot.tryAcquire();
      if (!offer.release) {
        current = undefined;
        return decline(frame.offerId, "slot-busy");
      }
      if (offer.cancelled) return releaseOffer(offer);
      try {
        validateOffer(frame.labels, await getCapacity());
      } catch {
        await releaseOffer(offer);
        return decline(frame.offerId, "capacity-mismatch");
      }
      if (offer.cancelled || !control?.send({ type: "accept", offerId: frame.offerId }))
        return releaseOffer(offer);
      offer.phase = "accepted";
    } catch (error) {
      await releaseOffer(offer);
      throw error;
    } finally {
      handshaking = false;
    }
  };

  const handleAssign = (frame) => {
    const offer = current;
    if (!offer || offer.offerId !== frame.offerId || offer.phase !== "accepted")
      throw new ProtocolError("Assignment does not match an accepted offer.");
    offer.phase = "running";
    const job = runJob(frame.claim, signal)
      .catch((error) => {
        if (!signal.aborted)
          log.error(`${label}: ${error instanceof Error ? error.message : "Job failed."}`);
      })
      .finally(() => releaseOffer(offer));
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };

  return {
    onOpen(socketControl) {
      control = socketControl;
    },
    onClose() {
      control = undefined;
      if (current && current.phase !== "running") {
        current.cancelled = true;
        void releaseOffer(current);
      }
    },
    onSlotChange() {
      if (!handshaking) control?.sendReport();
    },
    async onFrame(frame) {
      switch (frame.type) {
        case "ready":
          log.log(`${label}: connected to the dispatcher.`);
          return;
        case "offer":
          return handleOffer(frame);
        case "assign":
          return handleAssign(frame);
        case "withdraw":
          if (current?.offerId === frame.offerId && current.phase !== "running") {
            current.cancelled = true;
            await releaseOffer(current);
          }
          return;
        case "error":
          log.error(
            `${label}: dispatcher error ${printable(frame.code)}: ${printable(frame.message)}`
          );
          return;
      }
    },
    async drain() {
      await Promise.allSettled([...jobs]);
    },
  };
}
