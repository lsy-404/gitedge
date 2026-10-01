import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

export class GitResourceLimitError extends Error {}

export function gitHttpClient(remote: string, maxBytes = 24 * 1024 * 1024): HttpClient {
  const root = new URL(remote);
  let transferred = 0;
  function count(bytes: number): void {
    transferred += bytes;
    if (transferred > maxBytes)
      throw new GitResourceLimitError("Git operation exceeds the in-memory size limit.");
  }
  async function* responseBody(
    body: ReadableStream<Uint8Array> | null
  ): AsyncIterableIterator<Uint8Array> {
    if (!body) return;
    const reader = body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        count(result.value.byteLength);
        yield result.value;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  return {
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const url = new URL(request.url);
      const suffix = url.pathname.slice(root.pathname.length);
      if (
        url.origin !== root.origin ||
        !url.pathname.startsWith(root.pathname) ||
        !["/info/refs", "/git-upload-pack", "/git-receive-pack"].includes(suffix)
      )
        throw new Error("Git client attempted to leave its repository.");
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (request.body) {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of request.body) {
          count(chunk.byteLength);
          length += chunk.byteLength;
          chunks.push(chunk);
        }
        body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      const response = await fetch(url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      return {
        url: response.url,
        method: request.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody(response.body),
      };
    },
  };
}
