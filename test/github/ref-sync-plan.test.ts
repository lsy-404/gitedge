import { expect, it } from "vitest";
import { planGithubRefSync } from "../../workers/forge/src/github-sync-git";

const zero = "0".repeat(40);
const base = "a".repeat(40);
const local = "b".repeat(40);
const remote = "c".repeat(40);

it("publishes a new local ref when no common ref state exists", () => {
  expect(planGithubRefSync(local, null, null)).toEqual({
    status: "sync",
    direction: "outbound",
    before: zero,
    after: local,
  });
});

it("imports a new remote ref when no common ref state exists", () => {
  expect(planGithubRefSync(null, remote, null)).toEqual({
    status: "sync",
    direction: "inbound",
    before: zero,
    after: remote,
  });
});

it("sends a one-sided update from the side that moved beyond the common OID", () => {
  expect(planGithubRefSync(base, remote, base)).toEqual({
    status: "sync",
    direction: "inbound",
    before: base,
    after: remote,
  });
  expect(planGithubRefSync(local, base, base)).toEqual({
    status: "sync",
    direction: "outbound",
    before: base,
    after: local,
  });
});

it("propagates a remote deletion only while the local ref still matches its baseline", () => {
  expect(planGithubRefSync(base, null, base)).toEqual({
    status: "sync",
    direction: "inbound",
    before: base,
    after: zero,
  });
  expect(planGithubRefSync(local, null, base)).toEqual({ status: "conflict" });
});

it("propagates a local deletion only while the remote ref still matches its baseline", () => {
  expect(planGithubRefSync(null, base, base)).toEqual({
    status: "sync",
    direction: "outbound",
    before: base,
    after: zero,
  });
  expect(planGithubRefSync(null, remote, base)).toEqual({ status: "conflict" });
});

it("surfaces concurrent changes instead of choosing a side", () => {
  expect(planGithubRefSync(local, remote, base)).toEqual({ status: "conflict" });
  expect(planGithubRefSync(local, remote, null)).toEqual({ status: "conflict" });
});

it("does not enqueue equal refs", () => {
  expect(planGithubRefSync(base, base, local)).toEqual({ status: "unchanged" });
});
