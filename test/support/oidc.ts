export class FixtureOidc {
  readonly issuer = "https://identity.example.test";
  readonly clientId = "gitedge-oidc-client";
  idToken = "";
  readonly tokenRequests: Array<{ authorization: string | null; body: URLSearchParams }> = [];
  private constructor(
    private readonly key: CryptoKey,
    readonly publicJwk: JsonWebKey
  ) {}

  static async create(): Promise<FixtureOidc> {
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );
    return new FixtureOidc(keys.privateKey, await crypto.subtle.exportKey("jwk", keys.publicKey));
  }
  async sign(claims: Record<string, string | number | boolean>): Promise<string> {
    const encode = (bytes: Uint8Array) => {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
    };
    const encoder = new TextEncoder();
    const header = encode(
      encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }))
    );
    const payload = encode(encoder.encode(JSON.stringify(claims)));
    const content = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      this.key,
      encoder.encode(content)
    );
    return `${content}.${encode(new Uint8Array(signature))}`;
  }
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    if (url.href === `${this.issuer}/.well-known/openid-configuration`)
      return Response.json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        end_session_endpoint: `${this.issuer}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.href === `${this.issuer}/jwks`)
      return Response.json({
        keys: [{ ...this.publicJwk, kid: "test-key", use: "sig", alg: "RS256" }],
      });
    if (url.href === `${this.issuer}/token`) {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      this.tokenRequests.push({
        authorization: new Headers(init?.headers).get("Authorization"),
        body,
      });
      return Response.json({
        access_token: "ephemeral-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: this.idToken,
      });
    }
    return new Response("Not found", { status: 404 });
  };
}
