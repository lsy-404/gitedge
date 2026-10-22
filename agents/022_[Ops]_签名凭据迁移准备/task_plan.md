# Task plan

- [x] Inspect legacy production resource bindings, secret names and source policy.
- [x] Confirm GitEdge profile, credential and grant contracts at the deployed source revision.
- [x] Retrieve the current IRIS shell workflow and verify the source repository identity/default branch.
- [x] Prepare secret-free IRIS profile policy candidates from the supplied names and legacy recipes.
- [x] Extend candidate policies across active legacy signing consumers and inspect their workflows/artifacts.
- [x] Record the safest feasible server-side re-encryption design without deploying or adding a public export route.
- [x] Implement a fixed-scope legacy Worker RPC that only returns recipient-encrypted credentials.
- [x] Add a temporary GitEdge migration operation behind the existing recent-human credential write route.
- [x] Verify the recipient-encrypted envelope locally and reject unsupported kinds and unapproved profiles.
- [ ] Remove the temporary GitEdge import operation after the parent completes the authorized credential transfer.
- [ ] Commit both isolated worktrees locally without pushing or deploying.

# Scope

Reviewable one-time credential transfer implementation and secret-free IRIS profile policy preparation. No production worker deployment, secret write, request, policy or storage mutation is performed by this task.
