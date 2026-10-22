# Signing execution architecture

Signing uses the protected profile and request flow documented in [Account Runner signing](account-runner-signing.md). Runners are generic registrations matched by their reported operating system, architecture and tools. The account owner approves immutable signing profiles and manages encrypted credentials; task and lease authorization controls each credential grant.

There is no separate signing runner class, dedicated-host approval, or runner OS-identity approval. Windows credentials are encrypted by the service and delivered per task using the strict JSON format in the signing guide. Keep this page aligned with that current architecture.
