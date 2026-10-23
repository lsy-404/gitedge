# Findings

- Existing shared parser supports need-mem/cpu/disk/tool/time and is used by both server scheduling and broker preflight. Extend this parser instead of introducing another claim representation.
- Capacity already reports available RAM and work-directory free disk with bounded platform probes. No existing hardware inventory dependency is installed. GPU data must be measured rather than asserted in custom tags.
- GitHub bridge already uses a six-hour maximum. GitEdge workflow parsing and the local actions command default to 60 minutes, so both must change together.
- A guessed scripts/runner-labels.mjs path does not exist; locate label handling from imports before editing.

- Real Linux semantic run839962e0 completed on ARM withtimeout_minutes360; x64 could not meet RAM2GiB and disk50GiB. NVIDIA/VRAM8GiB negative run62868c41 remains queued with no runner/start.
- Desktop updaters fast-forwarded their clean source checkouts but failed before restart at the new pnpm dependency-install step. The original service processes and active jobs continued. Replaced that operator-only step with the exact pinned npm tarball and lockfile SHA-512, extracting through native tar without changing global tools or credentials. The first enlarged Windows parser command exceeded command-line length; switched parser validation to saved files before upload.
