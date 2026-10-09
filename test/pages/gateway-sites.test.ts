import { describe, expect, it } from "vitest";
import {
  handleGatewayRequest,
  withSecurityHeaders,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";
import { parseSitePath, siteContentType } from "../../workers/git/src/site";
import {
  pagesHostUrl,
  pagesPathUrl,
  UpdatePagesInputSchema,
} from "../../packages/contracts/src/pages";

const OID = "a".repeat(40);
const calls: Request[] = [];
const unlimited = {
  getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
};
const untouched: GatewayService = {
  fetch: async () => {
    throw new Error("service must not be called");
  },
};

function environment(sitesHost?: string): GatewayEnv {
  return {
    AUTH: untouched,
    FORGE: untouched,
    ASSETS: untouched,
    GIT: {
      fetch: async (request) => {
        calls.push(request);
        return new Response("site", {
          headers: { "Content-Security-Policy": "sandbox allow-scripts" },
        });
      },
    },
    RATE_LIMITER: unlimited,
    SITES_HOST: sitesHost,
  };
}

describe("Gateway site routing", () => {
  it("forwards path-scheme requests anonymously with the raw path", async () => {
    calls.length = 0;
    const response = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site/docs/a%20b.html?x=1", {
        headers: {
          Cookie: "session=secret",
          Authorization: "Bearer gep_x",
          "If-None-Match": '"e"',
        },
      }),
      environment()
    );
    expect(response.status).toBe(200);
    const forwarded = new URL(calls[0].url);
    expect(forwarded.searchParams.get("owner")).toBe("alice");
    expect(forwarded.searchParams.get("repo")).toBe("blog");
    expect(forwarded.searchParams.get("path")).toBe("/docs/a%20b.html");
    expect(forwarded.searchParams.get("search")).toBe("?x=1");
    expect(forwarded.searchParams.get("mode")).toBe("path");
    expect(calls[0].headers.has("Cookie")).toBe(false);
    expect(calls[0].headers.has("Authorization")).toBe(false);
    expect(calls[0].headers.get("If-None-Match")).toBe('"e"');
  });

  it("redirects roots to a trailing slash and routes previews by OID", async () => {
    const env = environment();
    const root = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site?x=1"),
      env
    );
    expect(root.status).toBe(308);
    expect(root.headers.get("Location")).toBe("/alice/blog/-/site/?x=1");
    const bare = await handleGatewayRequest(
      new Request(`https://git.example.com/alice/blog/-/preview/${OID}`),
      env
    );
    expect(bare.status).toBe(308);
    calls.length = 0;
    await handleGatewayRequest(
      new Request(`https://git.example.com/alice/blog/-/preview/${OID}/x.js`),
      env
    );
    expect(new URL(calls[0].url).searchParams.get("preview")).toBe(OID);
    expect(new URL(calls[0].url).searchParams.get("path")).toBe("/x.js");
    const badOid = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/preview/zz/"),
      env
    );
    expect(badOid.status).toBe(404);
  });

  it("refuses writes and reserved owners", async () => {
    const env = environment();
    const post = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site/", { method: "POST" }),
      env
    );
    expect(post.status).toBe(405);
  });

  it("refuses path-scheme subresources loaded by application pages", async () => {
    const env = environment();
    calls.length = 0;
    const embedded = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site/evil.js", {
        headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors" },
      }),
      env
    );
    expect(embedded.status).toBe(403);
    expect(calls).toHaveLength(0);
    const fetched = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site/data.json", {
        headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
      }),
      env
    );
    expect(fetched.status).toBe(403);
    const navigation = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site/", {
        headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" },
      }),
      env
    );
    expect(navigation.status).toBe(200);
    const sandboxed = await handleGatewayRequest(
      new Request("https://git.example.com/alice/blog/-/site/app.js", {
        headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" },
      }),
      env
    );
    expect(sandboxed.status).toBe(200);
    expect(sandboxed.headers.get("Vary")).toContain("Sec-Fetch-Site");
    expect(sandboxed.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    const hosted = await handleGatewayRequest(
      new Request("https://alice.sites.example.com/blog/app.js", {
        headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors" },
      }),
      environment("sites.example.com")
    );
    expect(hosted.status).toBe(200);
  });

  it("serves the host scheme only for the configured sites host", async () => {
    const env = environment("sites.example.com");
    calls.length = 0;
    const response = await handleGatewayRequest(
      new Request("https://alice.sites.example.com/blog/a.js"),
      env
    );
    expect(response.status).toBe(200);
    const forwarded = new URL(calls[0].url);
    expect(forwarded.searchParams.get("owner")).toBe("alice");
    expect(forwarded.searchParams.get("repo")).toBe("blog");
    expect(forwarded.searchParams.get("path")).toBe("/a.js");
    expect(forwarded.searchParams.get("mode")).toBe("host");
    expect(
      (await handleGatewayRequest(new Request("https://alice.sites.example.com/blog"), env)).status
    ).toBe(308);
    expect(
      (await handleGatewayRequest(new Request("https://alice.sites.example.com/"), env)).status
    ).toBe(404);
    expect(
      (await handleGatewayRequest(new Request("https://a.b.sites.example.com/blog/"), env)).status
    ).toBe(404);
    calls.length = 0;
    await handleGatewayRequest(
      new Request(`https://alice.sites.example.com/blog/-/preview/${OID}/`),
      env
    );
    expect(new URL(calls[0].url).searchParams.get("preview")).toBe(OID);
    calls.length = 0;
    const api = await handleGatewayRequest(
      new Request("https://alice.sites.example.com/api/auth/session"),
      env
    );
    expect(api.status).toBe(200);
    expect(new URL(calls[0].url).searchParams.get("repo")).toBe("api");
  });

  it("drops the application CSP on the sites host only", () => {
    const plain = withSecurityHeaders(new Response("x"), "/blog/", true);
    expect(plain.headers.has("Content-Security-Policy")).toBe(false);
    expect(plain.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(
      withSecurityHeaders(new Response("x"), "/", false).headers.get("Content-Security-Policy")
    ).toContain("default-src 'self'");
  });
});

describe("Pages helpers", () => {
  it("builds site urls", () => {
    expect(pagesPathUrl("alice", "my.repo")).toBe("/alice/my.repo/-/site/");
    expect(pagesHostUrl("alice", "blog", "Sites.Example.com")).toBe(
      "https://alice.sites.example.com/blog/"
    );
    expect(pagesHostUrl("alice", "blog", undefined)).toBeNull();
    expect(pagesHostUrl("alice-", "blog", "sites.example.com")).toBeNull();
  });

  it("normalizes and validates settings", () => {
    const base = { branch: "main", notFoundPath: null, spaFallback: false };
    expect(UpdatePagesInputSchema.parse({ ...base, folder: "docs/" }).folder).toBe("/docs");
    expect(UpdatePagesInputSchema.parse({ ...base, folder: "" }).folder).toBe("/");
    for (const folder of ["..", "a/../b", "/.git", "a\\b"])
      expect(UpdatePagesInputSchema.safeParse({ ...base, folder }).success, folder).toBe(false);
    expect(
      UpdatePagesInputSchema.safeParse({ ...base, folder: "/", branch: "refs/heads/x" }).success
    ).toBe(false);
  });

  it("parses site paths strictly", () => {
    expect(parseSitePath("/")).toEqual({ segments: [], directory: true });
    expect(parseSitePath("/a/b.html")).toEqual({ segments: ["a", "b.html"], directory: false });
    expect(parseSitePath("/a/%C3%A9/")).toEqual({ segments: ["a", "é"], directory: true });
    for (const bad of [
      "a",
      "/a//b",
      "/./a",
      "/../a",
      "/%2e%2e/a",
      "/a%2Fb",
      "/a%5Cb",
      "/a%00",
      "/%E0%A4%A",
    ])
      expect(parseSitePath(bad), bad).toBeNull();
  });

  it("looks up mime types", () => {
    expect(siteContentType("a.html")).toBe("text/html; charset=utf-8");
    expect(siteContentType("a.json")).toBe("application/json; charset=utf-8");
    expect(siteContentType("a.svg")).toBe("image/svg+xml; charset=utf-8");
    expect(siteContentType("a.wasm")).toBe("application/wasm");
    expect(siteContentType("noext")).toBe("application/octet-stream");
  });
});
