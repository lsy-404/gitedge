import { z } from "zod";
import type { SsoEnvironment, SsoProvider, SsoProviderSecrets } from "./types";

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  });
const common = {
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .refine((id) => !["providers", "identities"].includes(id)),
  label: z.string().trim().min(1).max(80),
  allowSignup: z.boolean().default(true),
};
const providerSchema = z.discriminatedUnion("protocol", [
  z
    .object({
      ...common,
      protocol: z.literal("oidc"),
      issuer: httpsUrl.refine((value) => !new URL(value).search),
      clientId: z.string().min(1).max(512),
      scopes: z
        .array(z.string().min(1).max(128))
        .max(20)
        .default(["openid", "profile", "email"])
        .refine((scopes) => scopes.includes("openid")),
      tokenAuthMethod: z
        .enum(["client_secret_basic", "client_secret_post", "none"])
        .default("client_secret_basic"),
    })
    .strict(),
  z
    .object({
      ...common,
      protocol: z.literal("saml"),
      issuer: z.string().min(1).max(2048),
      entryPoint: httpsUrl,
      certificates: z.array(z.string().min(100).max(20_000)).min(1).max(5),
      entityId: z.string().min(1).max(2048).optional(),
      signingCertificate: z.string().min(100).max(20_000).optional(),
      decryptionCertificate: z.string().min(100).max(20_000).optional(),
      signatureValidation: z.enum(["both", "assertion", "response"]).default("both"),
      logoutUrl: httpsUrl.optional(),
    })
    .strict(),
]);
const providersSchema = z
  .array(providerSchema)
  .max(20)
  .refine(
    (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
    "Provider identifiers must be unique."
  );
const secretsSchema = z.record(
  z.string(),
  z
    .object({
      clientSecret: z.string().min(1).max(4096).optional(),
      privateKey: z.string().min(1).max(20_000).optional(),
      decryptionKey: z.string().min(1).max(20_000).optional(),
    })
    .strict()
);

export function ssoProviders(env: SsoEnvironment): SsoProvider[] {
  const input: unknown = JSON.parse(env.SSO_PROVIDERS_JSON ?? "[]");
  return providersSchema.parse(input);
}
export function ssoSecrets(env: SsoEnvironment, provider: SsoProvider): SsoProviderSecrets {
  const input: unknown = JSON.parse(env.SSO_SECRETS_JSON ?? "{}");
  const secrets = secretsSchema.parse(input)[provider.id] ?? {};
  if (provider.protocol === "oidc" && provider.tokenAuthMethod !== "none" && !secrets.clientSecret)
    throw new Error("OIDC client credentials are missing.");
  if (
    provider.protocol === "saml" &&
    Boolean(provider.signingCertificate) !== Boolean(secrets.privateKey)
  )
    throw new Error("SAML signing certificate and key must be configured together.");
  if (
    provider.protocol === "saml" &&
    Boolean(provider.decryptionCertificate) !== Boolean(secrets.decryptionKey)
  )
    throw new Error("SAML decryption certificate and key must be configured together.");
  return secrets;
}
