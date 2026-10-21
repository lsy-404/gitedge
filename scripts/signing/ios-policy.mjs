import { createHash, X509Certificate } from "node:crypto";

export function validateIosProfile(
  profile,
  { teamId, bundleId, certificateSha1, now = Date.now() }
) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("profile_invalid");
  if (profile.TeamIdentifier?.length !== 1 || profile.TeamIdentifier[0] !== teamId)
    throw new Error("profile_team");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      profile.UUID ?? ""
    )
  )
    throw new Error("profile_uuid");
  const expiration = Date.parse(profile.ExpirationDate);
  if (!Number.isFinite(expiration) || expiration <= now) throw new Error("profile_expired");
  if (profile.ProvisionsAllDevices === true || profile.Entitlements?.["get-task-allow"] !== true)
    throw new Error("profile_not_development");
  if (
    !Array.isArray(profile.ProvisionedDevices) ||
    profile.ProvisionedDevices.length < 1 ||
    profile.ProvisionedDevices.some((device) => !isRegisteredDeviceId(device))
  )
    throw new Error("profile_devices");
  if (
    !Array.isArray(profile.ApplicationIdentifierPrefix) ||
    profile.ApplicationIdentifierPrefix.length < 1 ||
    profile.ApplicationIdentifierPrefix.some(
      (prefix) => typeof prefix !== "string" || !/^[A-Z0-9]{10}$/.test(prefix)
    )
  )
    throw new Error("profile_app_prefix");
  const appIdentifier = profile.Entitlements?.["application-identifier"];
  if (
    !profile.ApplicationIdentifierPrefix.some((prefix) =>
      matchesPattern(appIdentifier, `${prefix}.${bundleId}`)
    )
  )
    throw new Error("profile_bundle");
  if (!Array.isArray(profile.DeveloperCertificates) || profile.DeveloperCertificates.length !== 1)
    throw new Error("profile_certificate");
  const certificate = profile.DeveloperCertificates[0];
  const certificateBytes = Buffer.isBuffer(certificate)
    ? certificate
    : typeof certificate === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(certificate)
      ? Buffer.from(certificate, "base64")
      : null;
  if (
    !certificateBytes?.length ||
    createHash("sha1").update(certificateBytes).digest("hex").toUpperCase() !==
      certificateSha1.toUpperCase()
  )
    throw new Error("profile_certificate");
  const signer = new X509Certificate(certificateBytes);
  if (!signer.subject.includes(`OU=${teamId}`) || !signer.subject.includes("CN=Apple Development:"))
    throw new Error("certificate_identity");
  const certExpiration = Date.parse(signer.validTo);
  if (!Number.isFinite(certExpiration) || certExpiration <= now)
    throw new Error("certificate_expired");
  return {
    uuid: profile.UUID,
    expiration: new Date(expiration).toISOString(),
    certificateExpiration: new Date(certExpiration).toISOString(),
    deviceCount: profile.ProvisionedDevices.length,
  };
}

export function isRegisteredDeviceId(device) {
  return (
    typeof device === "string" &&
    /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$/.test(device)
  );
}

export function validateSignedEntitlements(entitlements, profile, { teamId, bundleId }) {
  const authorized = profile?.Entitlements;
  if (
    !entitlements ||
    typeof entitlements !== "object" ||
    Array.isArray(entitlements) ||
    !authorized ||
    typeof authorized !== "object" ||
    entitlements["com.apple.developer.team-identifier"] !== teamId ||
    entitlements["application-identifier"] !==
      `${profile.ApplicationIdentifierPrefix?.[0]}.${bundleId}` ||
    entitlements["get-task-allow"] !== true ||
    !isSubset(authorized, entitlements)
  )
    throw new Error("signature_entitlements");
  return true;
}

function isSubset(allowed, actual) {
  if (typeof actual === "string")
    return typeof allowed === "string" && matchesPattern(allowed, actual);
  if (typeof actual === "boolean" || typeof actual === "number") return actual === allowed;
  if (Array.isArray(actual))
    return (
      Array.isArray(allowed) &&
      actual.every((item) => allowed.some((value) => isSubset(value, item)))
    );
  if (
    actual &&
    typeof actual === "object" &&
    allowed &&
    typeof allowed === "object" &&
    !Array.isArray(allowed)
  ) {
    return Object.entries(actual).every(
      ([key, value]) => Object.hasOwn(allowed, key) && isSubset(allowed[key], value)
    );
  }
  return false;
}

function matchesPattern(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}
