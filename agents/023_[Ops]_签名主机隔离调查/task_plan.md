# Task plan

- [x] Read project instructions and prior host migration records.
- [x] Check local SSH configuration, available tools, and current GitHub job/runner state.
- [x] Inspect current signing scratch, ACL, and keychain cleanup paths.
- [x] Verify the authorized Windows SSH endpoint is reachable and collect candidate host key fingerprints without sending credentials.
- [ ] Use a credential-safe channel to authenticate and inspect Windows host identity, signing tools, active tasks, and task-level scratch cleanup.
- [ ] Locate and inspect the macOS signing host through an authorized connection, if its connection details become available.
- [ ] Report verified host capability, cleanup boundaries, active jobs, and any human input needed for real signing verification.
