import { describe, expect, it } from "vitest";
import { repositoryNameFromUrl, validateImportUrl } from "../../packages/contracts/src/import-url";
import { canTransition, IMPORT_TRANSITIONS } from "../../workers/forge/src/imports";

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
