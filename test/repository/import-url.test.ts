import { afterEach, describe, expect, it, vi } from "vitest";
import { repositoryNameFromUrl, validateImportUrl } from "../../packages/contracts/src/import-url";
import { canTransition, IMPORT_TRANSITIONS } from "../../workers/forge/src/imports";
import { isNonPublicAddress, resolvePublicHost } from "../../src/worker/common/public-host";

describe("import URL validation", () => {
  it("accepts public https remotes and strips query and fragment", () => {
    expect(validateImportUrl("https://github.com/acme/widgets.git?x=1#y")).toEqual({
      ok: true,
      url: "https://github.com/acme/widgets.git",
    });
    expect(validateImportUrl("https://git.example.org:443/a/b")).toMatchObject({ ok: true });
  });

  it.each([
    ["http://example.com/a.git", "scheme"],
    ["ssh://git@example.com/a.git", "scheme"],
    ["git@github.com:acme/a.git", "invalid"],
    ["https://user:pass@example.com/a.git", "credentials"],
    ["https://127.0.0.1/a.git", "ip_literal"],
    ["https://10.0.0.5/a.git", "ip_literal"],
    ["https://169.254.169.254/latest", "ip_literal"],
    ["https://2130706433/a.git", "ip_literal"],
    ["https://0x7f.1/a.git", "ip_literal"],
    ["https://[::1]/a.git", "ip_literal"],
    ["https://[fd00::1]/a.git", "ip_literal"],
    ["https://localhost/a.git", "local_host"],
    ["https://app.localhost/a.git", "local_host"],
    ["https://intranet/a.git", "local_host"],
    ["https://db.internal/a.git", "local_host"],
    ["https://printer.local/a.git", "local_host"],
    ["https://example.com:8443/a.git", "port"],
    [`https://example.com/${"a".repeat(2100)}`, "invalid"],
  ])("rejects %s", (input, reason) => {
    expect(validateImportUrl(input)).toEqual({ ok: false, reason });
  });
});

describe("repository name suggestion", () => {
  it("derives a slug from the last path segment", () => {
    expect(repositoryNameFromUrl("https://github.com/acme/Widgets.git")).toBe("widgets");
    expect(repositoryNameFromUrl("https://example.com/a/my repo")).toBe("my-repo");
    expect(repositoryNameFromUrl("not a url")).toBe("");
  });
});

describe("import state machine", () => {
  it("only moves forward, with failed jobs requeued", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("succeeded", "queued")).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(IMPORT_TRANSITIONS.succeeded).toEqual([]);
  });
});

describe("resolved address screening", () => {
  it.each([
    ["10.1.2.3", true],
    ["100.64.0.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["::1", true],
    ["::", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:127.0.0.1", true],
    ["64:ff9b::a00:1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
    ["2001:db8::1", true],
    ["not-an-ip", true],
    ["140.82.112.3", false],
    ["172.32.0.1", false],
    ["2606:4700:4700::1111", false],
    ["::ffff:140.82.112.3", false],
  ])("classifies %s", (address, blocked) => {
    expect(isNonPublicAddress(address)).toBe(blocked);
  });
});

describe("DNS-over-HTTPS host check", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubDns(records: Record<string, Array<{ type: number; data: string }>>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const type = input.searchParams.get("type") ?? "";
        return Response.json({ Status: 0, Answer: records[type] ?? [] });
      })
    );
  }

  it("accepts hosts with only public addresses", async () => {
    stubDns({ A: [{ type: 1, data: "140.82.112.3" }], AAAA: [] });
    expect(await resolvePublicHost("github.com")).toEqual({ ok: true });
  });

  it("rejects hosts with any private address, including through CNAME chains", async () => {
    stubDns({
      A: [
        { type: 5, data: "alias.example.com." },
        { type: 1, data: "10.0.0.8" },
      ],
    });
    expect(await resolvePublicHost("rebind.example.com")).toEqual({
      ok: false,
      reason: "private_address",
    });
  });

  it("fails closed when nothing resolves or the resolver errors", async () => {
    stubDns({});
    expect(await resolvePublicHost("missing.example.com")).toEqual({
      ok: false,
      reason: "unresolved",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    expect(await resolvePublicHost("down.example.com")).toEqual({
      ok: false,
      reason: "resolver_error",
    });
  });
});
