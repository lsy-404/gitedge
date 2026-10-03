import { describe, it, expect } from "vitest";
import { readReceiveCommands } from "../../workers/git/src/receive-commands";
const encoder = new TextEncoder();
function packet(text: string): string {
  return (encoder.encode(text).length + 4).toString(16).padStart(4, "0") + text;
}
function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(index, (index += Math.min(3, bytes.length - index))));
    },
  });
}
describe("Receive-pack command enforcement", () => {
  it("reads fragmented ref commands and preserves every streamed pack byte", async () => {
    const data = encoder.encode(
      packet(`${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status side-band-64k\n`) +
        packet(`${"b".repeat(40)} ${"c".repeat(40)} refs/heads/topic\n`) +
        "0000PACK\0binary-content"
    );
    const parsed = await readReceiveCommands(stream(data));
    expect(parsed.updates.map((item) => item.ref)).toEqual(["refs/heads/main", "refs/heads/topic"]);
    expect(new Uint8Array(await new Response(parsed.body).arrayBuffer())).toEqual(data);
  });
  it("rejects malformed and duplicate commands before forwarding", async () => {
    const command = packet(`${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\n`);
    for (const text of [
      "0003",
      "zzzz",
      command + command + "0000",
      packet(`${"0".repeat(40)} ${"a".repeat(40)} refs/heads/../bad\n`) + "0000",
      "0000",
    ])
      await expect(readReceiveCommands(stream(encoder.encode(text)))).rejects.toThrow();
  });
  it("bounds the command section and cancels rejected streams", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("ffff" + "a".repeat(65536)));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readReceiveCommands(oversized)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
