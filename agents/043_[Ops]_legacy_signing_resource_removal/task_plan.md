# Task plan

- [x] Record explicit authorization to delete the three old repositories and old Worker, signing history and encrypted certificate backups after dependency checks.
- [x] Verify current consumers, GitEdge code and deployed Worker bindings no longer depend on the exact legacy resources.
- [x] Inventory the old namespace and two buckets without reading credential object contents; verify current GitEdge credential/profile metadata and runner activity.
- [ ] Delete only the three archived legacy repositories after confirming no actual job is active.
- [x] Empty and delete the two dedicated old R2 buckets, delete the old Durable Object namespace/history through the supported class deletion operation, and remove the old Worker.
- [ ] Verify absence of old resources, preserve current GitEdge credentials and running tasks, and record final readbacks.
- [ ] Deliver audit and accurate repository status documentation through isolated clean main integration.
