# Progress

- Recorded the additional user request while retaining the IRIS release recovery scope.
- Read capacity probing, contracts, broker deadlines and the current scheduler. No runner restart or active-task cancellation performed.

- Shared semantic parser and strict GPU capacity contract implemented; server candidate SQL derives resource prefixes from the same canonical list. Reserved prefixes cannot be supplied as registration/custom metadata.
- Used maintained systeminformation 5.33.16 for hardware discovery in an eight-second bounded child process, cached ten minutes. The real Windows probe reports AMD with unknown dedicated VRAM and therefore cannot satisfy a VRAM request.
- Focused unit checks passed 52/52, Worker integration 21/21 and UI 9/9; updated native-candidate resource fixture passed the seven bridge tests. Actions and Forge typechecks passed after generating Actions bindings. Web build passed.
- Initial direct Actions tsc lacked generated ignored binding declarations; the documented typecheck:actions command generated them and passed. Corrected mismatched patch context and the unsupported delete/add-same-file patch; source was then formatted and checked.
- The global agents ignore required explicit force-add of new audit files; no audit file was lost.

- Main fast-forwarded and pushed at75f429c. Actions341231de, Forge7d1829ef and Gatewayccaad66c deployed with existing credentials and keep-vars; container rollout explicitly disabled to preserve existing images and running container jobs.
- Linux ARM updated75f429c with45-second stable process receipt; Linux x64 waited for its active native reader to end and updated75f429c with45-second receipt, then accepted the next IRIS prepare job. Both now report GPU inventory in live D1 with no holds or failures.
- Canonical demand69a4268c was reissued from GitHub runner145 to146 after another job consumed145. The original job then completed with cleanup_pending0, proving production reconciliation.
- Private Runner commitcc71f2e staged Mac and Windows idle updaters. Staging runs succeeded, but Mac receipt reports failure and all three old desktop brokers still report no GPUs. Added fixed source/receipt diagnostics; no active job was cancelled. One archive-generator quoting error was corrected before any remote script was uploaded.

- Allfive broker runtimes now report the new capacity format. Mac runtime verificationd40b9e62 passed and removed its completed updater; Windows verification5bee9d45 passed after scoping git safe.directory to the two canonical installation roots, and removed both completed updater tasks.
- Actual routing completed: Linux839962e0 on ARM, AppleGPU4a9fbafb on Mac, Windowse2b9af8c on Windows. All three omitted timeout-minutes and stored360. GPUnegative62868c41 remained unassigned for the observation window, then was cancelled as an owned queued verification; no user job was cancelled.
- Exact-source hostedCI39914279233 passed typecheck, unit and Worker suites but failed one Web locale reference test (415/416 passed). Added gpu to its existing dynamic-reference registry. Focused locale/dashboard suite passed16/16. Windows full Web run encountered file:///logo.svg URL parsing errors (42files passed,10failed); that local test-environment boundary is recorded rather than weakening assertions. The Linux hosted suite is the full supported CI gate.
- New signing approvals, platform/source credentials and running IRIS jobs remain untouched. Signed-product publication is still in progress.
