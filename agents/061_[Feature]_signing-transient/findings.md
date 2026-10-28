# Findings
OIDC and GitHub run validation remain admission controls. R2 multipart parts are 8 MiB. Durable Object alarms enforce source and delivery-cache retention; R2 lifecycle is a fallback whose deletion can be delayed. Existing immutable profile snapshots still include artifactName, which no longer participates in transport.
The signing integration initially failed on an unsupported inter-TransformStream pipe; bounded per-part buffering fixed the actual upload path. Old tests required adaptation to the new contract.
