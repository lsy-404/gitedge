import { describe, expect, it } from "vitest";
import {
  CreateAccessTokenInputSchema,
  accessTokenAllows,
  accessTokenAllowsRepository,
  requiredAccessTokenScope,
} from "../../packages/contracts/src/index";

describe("access token scopes", () => {
  it("lets admin imply everything and write scopes imply repository reads", () => {
    expect(accessTokenAllows({ scopes: ["admin"] }, "org:read")).toBe(true);
    expect(accessTokenAllows({ scopes: ["repo:write"] }, "repo:read")).toBe(true);
    expect(accessTokenAllows({ scopes: ["issues:write"] }, "repo:read")).toBe(true);
    expect(accessTokenAllows({ scopes: ["repo:read"] }, "repo:write")).toBe(false);
    expect(accessTokenAllows({ scopes: ["repo:write"] }, "issues:write")).toBe(false);
    expect(accessTokenAllows({ scopes: ["repo:read"] }, "org:read")).toBe(false);
  });

  it("maps requests to the narrowest scope", () => {
    expect(requiredAccessTokenScope("forge", "GET", ["repositories", "r1"])).toBe("repo:read");
    expect(requiredAccessTokenScope("forge", "GET", ["organizations"])).toBe("org:read");
    expect(requiredAccessTokenScope("forge", "POST", ["organizations"])).toBe("admin");
    expect(requiredAccessTokenScope("forge", "POST", ["repositories"])).toBe("repo:write");
    expect(requiredAccessTokenScope("forge", "DELETE", ["repositories", "r1"])).toBe("admin");
    expect(requiredAccessTokenScope("forge", "GET", ["usage"])).toBe("repo:read");
    expect(requiredAccessTokenScope("forge", "POST", ["repository-imports"])).toBe("repo:write");
    expect(
      requiredAccessTokenScope("forge", "POST", ["repository-imports", "job-1", "retry"])
    ).toBe("repo:write");
    expect(requiredAccessTokenScope("forge", "POST", ["repositories", "r1", "transfer"])).toBe(
      "admin"
    );
    expect(requiredAccessTokenScope("forge", "POST", ["repositories", "r1", "issues"])).toBe(
      "issues:write"
    );
    expect(
      requiredAccessTokenScope("forge", "POST", [
        "repositories",
        "r1",
        "pull-requests",
        "1",
        "merge",
      ])
    ).toBe("pulls:write");
    expect(requiredAccessTokenScope("forge", "PUT", ["repositories", "r1", "collaborators"])).toBe(
      "admin"
    );
    expect(requiredAccessTokenScope("git", "POST", ["repositories", "r1", "edit"])).toBe(
      "repo:write"
    );
    expect(requiredAccessTokenScope("git", "POST", ["repositories", "r1", "merge"])).toBe(
      "pulls:write"
    );
    expect(requiredAccessTokenScope("actions", "POST", ["repositories", "r1", "runs"])).toBe(
      "repo:write"
    );
    expect(requiredAccessTokenScope("git", "POST", ["repositories", "r1", "tags"])).toBe(
      "repo:write"
    );
    expect(requiredAccessTokenScope("git", "DELETE", ["repositories", "r1", "tags"])).toBe(
      "repo:write"
    );
    for (const method of ["POST", "PATCH", "PUT", "DELETE"])
      expect(
        requiredAccessTokenScope("forge", method, ["repositories", "r1", "releases", "x"])
      ).toBe("repo:write");
    expect(requiredAccessTokenScope("forge", "GET", ["repositories", "r1", "releases"])).toBe(
      "repo:read"
    );
  });

  it("applies the repository allowlist only when present", () => {
    expect(accessTokenAllowsRepository({}, "r1")).toBe(true);
    expect(accessTokenAllowsRepository({ repositoryIds: ["r2"] }, "r1")).toBe(false);
    expect(accessTokenAllowsRepository({ repositoryIds: ["r1"] }, "r1")).toBe(true);
  });

  it("requires a bounded expiry and unique scopes", () => {
    const valid = { name: "ci", scopes: ["repo:read"], expiresInDays: 365 };
    expect(CreateAccessTokenInputSchema.safeParse(valid).success).toBe(true);
    expect(CreateAccessTokenInputSchema.safeParse({ ...valid, expiresInDays: 366 }).success).toBe(
      false
    );
    expect(
      CreateAccessTokenInputSchema.safeParse({ ...valid, expiresInDays: undefined }).success
    ).toBe(false);
    expect(
      CreateAccessTokenInputSchema.safeParse({ ...valid, scopes: ["repo:read", "repo:read"] })
        .success
    ).toBe(false);
  });
});
