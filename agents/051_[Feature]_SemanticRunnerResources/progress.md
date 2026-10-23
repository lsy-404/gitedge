# Progress

- Recorded the additional user request while retaining the IRIS release recovery scope.
- Read capacity probing, contracts, broker deadlines and the current scheduler. No runner restart or active-task cancellation performed.

- Shared semantic parser and strict GPU capacity contract implemented; server candidate SQL derives resource prefixes from the same canonical list. Reserved prefixes cannot be supplied as registration/custom metadata.
- Used maintained systeminformation 5.33.16 for hardware discovery in an eight-second bounded child process, cached ten minutes. The real Windows probe reports AMD with unknown dedicated VRAM and therefore cannot satisfy a VRAM request.
- Focused unit checks passed 52/52, Worker integration 21/21 and UI 9/9; updated native-candidate resource fixture passed the seven bridge tests. Actions and Forge typechecks passed after generating Actions bindings. Web build passed.
- Initial direct Actions tsc lacked generated ignored binding declarations; the documented typecheck:actions command generated them and passed. Corrected mismatched patch context and the unsupported delete/add-same-file patch; source was then formatted and checked.
- The global agents ignore required explicit force-add of new audit files; no audit file was lost.
