export async function readTextLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readJsonLimited(
  request: Request,
  maximumBytes = 1_048_576
): Promise<unknown> {
  try {
    const text = await readTextLimited(request.body, maximumBytes);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

export const SMALL_JSON_BYTES = 65_536;
