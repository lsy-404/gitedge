import { z } from "zod";
import type { ColabAssignment } from "./session-backend";

const REQUEST_TIMEOUT_MS = 60_000;
const KERNEL_ATTEMPTS = 3;
const kernelSchema = z.object({ id: z.string().min(1) });
const messageSchema = z.object({
  channel: z.string().optional(),
  header: z.object({ msg_type: z.string() }),
  parent_header: z.object({ msg_id: z.string().optional() }).partial().optional(),
  content: z.record(z.string(), z.unknown()).default({}),
});

export interface CellResult {
  status: "matched" | "error" | "finished";
  output: string;
}

function proxyHeaders(runtime: ColabAssignment): Headers {
  return new Headers({
    Authorization: `Bearer ${runtime.proxyToken}`,
    "X-Colab-Runtime-Proxy-Token": runtime.proxyToken,
    "X-Colab-Client-Agent": "colab-cli",
  });
}

function proxyUrl(runtime: ColabAssignment, path: string): URL {
  return new URL(path, runtime.proxyUrl.endsWith("/") ? runtime.proxyUrl : `${runtime.proxyUrl}/`);
}

async function startKernel(runtime: ColabAssignment): Promise<string> {
  const headers = proxyHeaders(runtime);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  // A freshly assigned runtime can still be booting, so timeouts and gateway errors are retried.
  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(proxyUrl(runtime, "api/kernels"), {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "python3" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      if (attempt >= KERNEL_ATTEMPTS) throw cause;
    }
    if (response?.ok) return kernelSchema.parse(await response.json()).id;
    if (response && (![502, 503, 504].includes(response.status) || attempt >= KERNEL_ATTEMPTS))
      throw new Error(`The Colab runtime refused a kernel (HTTP ${response.status}).`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
  }
}

async function connectKernel(
  runtime: ColabAssignment,
  kernelId: string,
  session: string
): Promise<WebSocket> {
  const url = proxyUrl(runtime, `api/kernels/${encodeURIComponent(kernelId)}/channels`);
  url.searchParams.set("session_id", session);
  url.searchParams.set("token", runtime.proxyToken);
  url.searchParams.set("colab-runtime-proxy-token", runtime.proxyToken);
  const headers = proxyHeaders(runtime);
  headers.set("Upgrade", "websocket");
  // An abort signal on an upgraded fetch could cut the socket later, so the wait is raced instead.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    fetch(url, { headers }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("The Colab kernel did not accept the connection in time.")),
        REQUEST_TIMEOUT_MS
      );
    }),
  ]).finally(() => clearTimeout(timer));
  const socket = response.webSocket;
  if (!socket)
    throw new Error(`The Colab kernel refused the connection (HTTP ${response.status}).`);
  socket.accept();
  return socket;
}

function executeRequest(code: string, session: string): { id: string; frame: string } {
  const id = crypto.randomUUID();
  return {
    id,
    frame: JSON.stringify({
      header: {
        msg_id: id,
        username: "gitedge",
        session,
        msg_type: "execute_request",
        version: "5.3",
        date: new Date().toISOString(),
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: false,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      channel: "shell",
      buffers: [],
    }),
  };
}

/** Runs Python in a fresh kernel on the runtime until its output contains the marker, it fails or the timeout passes. */
export async function runCell(
  runtime: ColabAssignment,
  code: string,
  marker: string,
  timeoutMs: number
): Promise<CellResult> {
  const kernelId = await startKernel(runtime);
  const session = crypto.randomUUID();
  const socket = await connectKernel(runtime, kernelId, session);
  const request = executeRequest(code, session);
  let output = "";
  try {
    return await new Promise<CellResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The Colab kernel did not answer in time.")),
        timeoutMs
      );
      const finish = (result: CellResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let parsed: z.infer<typeof messageSchema>;
        try {
          const message = messageSchema.safeParse(JSON.parse(event.data));
          if (!message.success) return;
          parsed = message.data;
        } catch {
          return;
        }
        if (parsed.parent_header?.msg_id !== request.id) return;
        const type = parsed.header.msg_type;
        if (type === "stream" && typeof parsed.content.text === "string") {
          output = (output + parsed.content.text).slice(-4096);
          if (output.includes(marker)) finish({ status: "matched", output });
        } else if (type === "error") {
          const detail = `${String(parsed.content.ename ?? "Error")}: ${String(parsed.content.evalue ?? "")}`;
          finish({ status: "error", output: `${output}${detail}`.slice(-4096) });
        } else if (type === "execute_reply" && parsed.content.status !== "ok") {
          finish({ status: "error", output });
        } else if (type === "status" && parsed.content.execution_state === "idle") {
          // Idle on iopub follows every output of the request; the shell reply may arrive earlier.
          finish({ status: "finished", output });
        }
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("The Colab kernel closed the connection."));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("The Colab kernel connection failed."));
      });
      socket.send(request.frame);
    });
  } finally {
    try {
      socket.close(1000, "done");
    } catch {
      // Already closed by the runtime.
    }
  }
}
