# Findings

- Existing shared parser supports need-mem/cpu/disk/tool/time and is used by both server scheduling and broker preflight. Extend this parser instead of introducing another claim representation.
- Capacity already reports available RAM and work-directory free disk with bounded platform probes. No existing hardware inventory dependency is installed. GPU data must be measured rather than asserted in custom tags.
- GitHub bridge already uses a six-hour maximum. GitEdge workflow parsing and the local actions command default to 60 minutes, so both must change together.
- A guessed scripts/runner-labels.mjs path does not exist; locate label handling from imports before editing.
