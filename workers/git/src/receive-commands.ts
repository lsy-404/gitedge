import { GitBranchSchema, GitOidSchema } from "../../../packages/contracts/src/forge";

export interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}
export class InvalidReceiveCommands extends Error {}
export async function readReceiveCommands(body: ReadableStream<Uint8Array> | null): Promise<{
  updates: RefUpdate[];
  body: ReadableStream<Uint8Array>;
  cancel: () => Promise<void>;
}> {
  if (!body) throw new InvalidReceiveCommands("Missing receive-pack request.");
  const reader = body.getReader(),
    chunks: Uint8Array[] = [],
    updates: RefUpdate[] = [];
  let prefix = new Uint8Array(0),
    offset = 0,
    done = false;
  try {
    while (!done) {
      while (prefix.length - offset >= 4) {
        const header = new TextDecoder().decode(prefix.subarray(offset, offset + 4));
        if (!/^[0-9a-f]{4}$/i.test(header))
          throw new InvalidReceiveCommands("Invalid receive-pack header.");
        const length = Number.parseInt(header, 16);
        if (length === 0) {
          offset += 4;
          done = true;
          break;
        }
        if (length < 4 || length > 65520)
          throw new InvalidReceiveCommands("Invalid command length.");
        if (prefix.length - offset < length) break;
        let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          prefix.subarray(offset + 4, offset + length)
        );
        const nul = text.indexOf("\0");
        if (nul >= 0) {
          if (updates.length) throw new InvalidReceiveCommands("Invalid command capabilities.");
          text = text.slice(0, nul);
        }
        text = text.replace(/\n$/, "");
        const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/(?:heads|tags)\/(.+))$/.exec(text);
        if (
          !match ||
          !GitOidSchema.safeParse(match[1]).success ||
          !GitOidSchema.safeParse(match[2]).success ||
          !GitBranchSchema.safeParse(match[4]).success ||
          updates.some((update) => update.ref === match[3])
        )
          throw new InvalidReceiveCommands("Invalid ref update.");
        updates.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
        if (updates.length > 128) throw new InvalidReceiveCommands("Too many ref updates.");
        offset += length;
      }
      if (done) break;
      if (prefix.length >= 65536)
        throw new InvalidReceiveCommands("Command section exceeds its limit.");
      const next = await reader.read();
      if (next.done) throw new InvalidReceiveCommands("Incomplete command section.");
      chunks.push(next.value);
      const size = Math.min(next.value.length, 65536 - prefix.length),
        joined = new Uint8Array(prefix.length + size);
      joined.set(prefix);
      joined.set(next.value.subarray(0, size), prefix.length);
      prefix = joined;
    }
    if (!updates.length) throw new InvalidReceiveCommands("No ref updates were provided.");
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
          return;
        }
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      },
      async cancel() {
        await reader.cancel();
        reader.releaseLock();
      },
    });
    return { updates, body: stream, cancel: () => stream.cancel() };
  } catch (error) {
    await reader.cancel();
    reader.releaseLock();
    throw error;
  }
}
