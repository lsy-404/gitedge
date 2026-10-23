# Semantic runner resources

- [x] Inspect the canonical parser, capacity schema, broker probes and timeout defaults.
- [ ] Parse RAM, CPU, DISK, GPU vendor and VRAM requirements in standard runs-on labels.
- [ ] Enforce actual reported capacity in scheduler and local preflight; reject reserved resource labels as custom metadata.
- [ ] Report hardware GPU capacity using supported platform probes and fail closed on unknown data.
- [ ] Default native build execution to 360 minutes and update user documentation.
- [ ] Verify resource boundaries, host reporting and live scheduling without interrupting tasks.

Requirements are case insensitive and conjunctive. G and M use GiB/MiB consistent with existing capacity metrics. VRAM must be satisfied by one matching GPU, never by adding several undersized GPUs. Existing explicit timeouts remain authoritative. GPU-INVIDA is treated as a typo in the example; document GPU-NVIDIA.
