# Progress

- Copied the existing fixed-window Windows native-signing log probe into this audit directory and narrowed it to the terminal run's start/completion window. No host state or processes are changed.


- Added strict single-candidate behavior and explicit expected identifiers. GitEdge's actual workflow parser accepts the generated Windows workflow with only read permission and the fixed Windows native-tool labels.
- First dispatch `c3e2fae1-72cd-400d-a306-eeeaad19ab05` was successful, but its fixed root-one scan found no candidates. D1 runner metadata for the target native run maps it to `windows-broker-2`; narrowed the same fixed-window probe to root two. The initial result is not used to infer a cause.
- Corrected root-two dispatch completed: controller run `39886270288`, GitEdge run `88e0db61-29eb-493c-b4f9-2eb49407a01e`, workflow commit `77781f320d319532d662efe99761116e0e9f2e09`. The fixed summary found one candidate and returned `SIGNING_FAILED` at `01:39:07.8009454Z`, no specific diagnostic, and no lease/heartbeat failure flags. No host process or task was changed.
- Extended the fixed-root diagnostic to extract only built-in error class names and ran a dummy-context smoke against the installed reader and ACL helper. Controller run `39886759063` dispatched GitEdge run `b75b3497-f6f1-444e-97e5-3c676fe56b34` at commit `17910b8552c4f792bcd2913f0b54c06c4f055cb0`. It reported `Error` at `01:39:07.8009783Z`; the synthetic smoke returned `INVALID_CONTEXT_FILE`, PowerShell exit code 1, one link, no symlink, 728 bytes. No production state changed.
