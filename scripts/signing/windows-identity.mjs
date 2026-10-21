const APPROVED_IDENTITY_MODES = new Set(["azure-managed-identity", "azure-workload-identity"]);

export function approvedAzureIdentityMode(profile) {
  const identityMode = profile?.policy?.windowsIdentity;
  if (!APPROVED_IDENTITY_MODES.has(identityMode))
    throw new Error("approved Azure identity provider missing");
  return identityMode;
}
