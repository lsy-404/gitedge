# Findings

- Windows credentials are already validated by `windowsCredentialsSchema` in `packages/contracts/signing-native.mjs`; installation uses `installSigningCredentials(repositoryId, profile, platform, credentials)`.
- `useReauthRetry` keeps the supplied operation in memory and invokes it after `ReauthPrompt` confirmation. The Windows form must preserve values while reauthentication is pending, then clear on success or explicit cancellation.
- Existing JSON input is also used for Apple and `github-source`; preserve that path for those platforms.
- UI tests live under the repository-root `test/ui` directory and mount Vue components through `task-support.ts`.
