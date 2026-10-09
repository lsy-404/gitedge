import { GitBranchSchema, GitRefNameSchema } from "../../packages/contracts/src/forge";
import { describe, it, expect } from "vitest";
import { ReceiveReport, readReceiveCommands } from "../../workers/git/src/receive-commands";
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

it("rejects symbolic and fully qualified names where a branch name is required", () => {
  for (const name of ["HEAD", "refs/heads/main", "refs/tags/v1", "@", "-topic"])
    expect(GitBranchSchema.safeParse(name).success).toBe(false);
  for (const name of ["main", "feature/ui", "release-1.0"])
    expect(GitBranchSchema.safeParse(name).success).toBe(true);
});

it("retains valid tag names that are reserved for branch inputs", () => {
  for (const name of ["HEAD", "@", "-release", "refs/release"])
    expect(GitRefNameSchema.safeParse(name).success).toBe(true);
});

function sideband(band: number, payload: string): Uint8Array {
  const data = encoder.encode(payload);
  const frame = new Uint8Array(data.length + 5);
  frame.set(encoder.encode((data.length + 5).toString(16).padStart(4, "0")));
  frame[4] = band;
  frame.set(data, 5);
  return frame;
}
function feedInPieces(report: ReceiveReport, bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 3) report.feed(bytes.slice(index, index + 3));
}
describe("Receive-pack report status", () => {
  it("collects accepted refs from a plain report", () => {
    const report = new ReceiveReport();
    feedInPieces(
      report,
      encoder.encode(
        packet("unpack ok\n") +
          packet("ok refs/heads/main\n") +
          packet("ng refs/heads/topic non-fast-forward\n") +
          "0000"
      )
    );
    expect(report.accepted()).toEqual(new Set(["refs/heads/main"]));
  });
  it("reads the report from side-band data and ignores progress", () => {
    const inner = packet("unpack ok\n") + packet("ok refs/heads/topic\n") + "0000";
    const bytes = [
      sideband(2, "Resolving deltas\n"),
      sideband(1, inner.slice(0, 9)),
      sideband(1, inner.slice(9)),
      encoder.encode("0000"),
    ];
    const report = new ReceiveReport();
    for (const part of bytes) feedInPieces(report, part);
    expect(report.accepted()).toEqual(new Set(["refs/heads/topic"]));
  });
  it("accepts nothing when unpacking failed or the server reported a fatal error", () => {
    const unpackFailed = new ReceiveReport();
    unpackFailed.feed(
      encoder.encode(packet("unpack index-pack failed\n") + packet("ok refs/heads/main\n"))
    );
    expect(unpackFailed.accepted()).toEqual(new Set());
    const fatal = new ReceiveReport();
    fatal.feed(sideband(3, "fatal: storage unavailable\n"));
    expect(fatal.accepted()).toEqual(new Set());
  });
  it("reports an unknown outcome when no report status was sent", () => {
    expect(new ReceiveReport().accepted()).toBeNull();
    const garbage = new ReceiveReport();
    garbage.feed(encoder.encode("not a packet line"));
    expect(garbage.accepted()).toBeNull();
  });
});
