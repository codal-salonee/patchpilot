# Security Model

## Trust Boundary

`workflow_run` can have write permissions and secrets even when the failed workflow did not. Never check out a failed commit and run `npm install`, tests, or scripts directly in that job. The consumer workflow invokes reviewed bot code pinned to a full commit SHA. The bot independently checks the run through GitHub's API.

Eligible runs are completed failures from allowlisted workflows, triggered by `push` on the same repository's current default-branch tip. Forks, PR events, non-default branches, bot branches, successful runs, and stale commits are skipped. This is deliberately narrower than a general issue/webhook repair service.

Only the trusted host process receives the GitHub token and API key. Git uses a one-command environment header, not a credential-bearing URL or persistent Git config. Target code never runs on that host. Model output is data, never a shell command.

## Patch Enforcement

- Edits target existing, tracked source files retrieved as editable context. Tests may supply evidence but cannot be edited.
- Paths must be relative source paths under trusted directory prefixes. Hidden components, traversal, backslashes, symlinks, unsupported extensions, and test paths are rejected.
- Every `old` string must match exactly once. No-op changes, unknown JSON fields, new files, and diagnostic-suppression directives are rejected.
- Limits: 5 files, 200 changed lines, 24 KB of replacement content per proposal. A separate final diff gate applies file/line/byte limits cumulatively across all attempts, including diff headers.
- All edits are validated before writes. An edit rejected by the cumulative diff gate is rolled back. Failed verification edits may remain for the next correction attempt in the disposable workspace.
- No shell patches, dependency changes, workflow changes, auto-approvals, or auto-merges.

Tests and suppression filters cannot detect every semantic bypass. For example, an allowed source function can still be changed to return hard-coded test answers. Verification is evidence, not proof; review the resulting source diff.

## Verification Isolation

Verification runs on a temporary filesystem copy, excluding `.git`, `.env*`, `.npmrc`, dependencies, and common build output. It does not mount the original checkout, host home directory, SSH agent, Docker socket, or credential files.

Each container runs as the host's unprivileged user, with dropped capabilities, no privilege escalation, read-only root, a bounded temporary directory, PID/CPU/memory limits, and a five-minute command timeout. Dependency installation uses `npm ci --ignore-scripts` with networking. Typecheck, lint, and tests run in separate containers with **no network** and npm pre/post lifecycle hooks disabled. Containers and snapshots are removed afterward, including on failure.

The writable snapshot is shared between checks, not with the host repository. Use ephemeral GitHub-hosted Linux runners. Do not run this bot with write credentials on a long-lived runner containing sensitive services or unrelated workspaces. Docker is defense in depth, not a hardened hostile-code VM. Dependencies can exploit toolchain bugs; use disposable VMs/microVMs for stronger isolation. Offline oracle evaluation executes only committed, known fixture repairs locally; live-model evaluation always uses Docker.

Checks must be deterministic and offline. Projects that require secrets, services, lifecycle builds, or a different Node version are unsupported by the default sandbox. Missing scripts/lockfiles, dependency installation errors, and unavailable Docker become fallback issues, not invented source fixes.

## Prompt Injection And Secrets

Source and logs are untrusted user-message data. A separate fixed system prompt describes the repair task, forbids following embedded instructions, and requests minimal behavior-preserving changes. Strict schema validation and path/diff enforcement remain necessary even if the model ignores that prompt.

Before prompting, known runtime credentials, recognizable token formats, private-key blocks, authorization values, secret assignments, and URL passwords are redacted. Files such as `.env` and workflow/config files are never retrieved as source. Outputs are sanitized again before issue/PR publication and untrusted text is rendered as indented text with mentions neutralized.

Redaction is best effort, not a universal secret detector. Do not send sensitive repositories to an external model without organizational approval. Encoded, fragmented, or unrecognized secrets can evade filters. Prompt injection cannot be completely prevented by text instructions. Never let a successful check substitute for human review.

## Operational Controls

Grant only target-repository Actions read and contents/issues/pull-requests write. Use an OpenAI project with a small budget and rate limits. The bot caps attempts at three, logs at three failed jobs and bounded downloads, context at five files/40,000 characters, and model output at 6,000 completion tokens. A fallback issue uses bounded sanitized diagnostics, not the entire log.

Concurrency is serialized per run in the workflow. Existing PRs (including closed ones) and open fallback issues are detected before repeat work. A partially created branch is not force-pushed; inspect/delete it manually before retrying if PR creation failed. Closed fallback issues may be recreated on a deliberate rerun. Distinct CI runs are independent; GitHub/API failures can still require maintainer intervention.

GitHub API failures during run lookup or fallback-issue creation exit nonzero. Log/API errors never print raw provider response bodies intentionally, but host tooling and your own scripts should also avoid logging credentials. Always inspect workflow logs before sharing them.