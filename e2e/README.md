# thumbmux package demo e2e

The Playwright suite drives the package demo and real tmux sessions inside one
disposable container on the public repository's GitHub-hosted runner. The
canonical runner admits a clean exact commit, creates a unique labelled
container, asks
Docker for an ephemeral localhost port, performs a frozen install, waits for
the authenticated demo to answer, runs every `e2e/*.spec.ts`, and removes the
container on success, failure, or interruption.

The specs only create sessions whose names begin with `sim-` and clean up each
session after the test.

## Run the complete suite

From the package root in that public GitHub-hosted job:

```bash
bun install --frozen-lockfile
./node_modules/.bin/playwright install --with-deps chromium
./e2e/run-container.sh
```

Docker, curl, tar, the pinned Bun, and Playwright Chromium are required on the
disposable runner. A local/monorepo invocation fails closed before Docker,
tmux, or Playwright lifecycle begins. Test traces, screenshots, the Playwright
log, and a token-redacted demo log are retained in the runner-owned artifacts
directory.

## Runner-owned settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `THUMBMUX_E2E_ARTIFACTS` | `$RUNNER_TEMP/thumbmux-e2e-artifacts.<run-id>` | Optional artifact directory, restricted under `RUNNER_TEMP` |
| image | `oven/bun:1` | Fixed disposable container image |
| `THUMBMUX_E2E_READY_TIMEOUT` | `90` | Demo readiness timeout in seconds |
| container | `thumbmux-e2e-<run-id>` | Fixed unique run-specific name and labels |
| host port | Docker-assigned ephemeral `127.0.0.1` port | Ports `47779` and `47780` are rejected |
| demo port | `7681` | Fixed port inside the container |
| package source | exact admitted `git archive` | Live-tree/source-root overrides are forbidden |
| Playwright | `node_modules/.bin/playwright` | Binary override is forbidden |

Container/image/port/package/binary overrides are rejected. Cleanup targets
only the exact daemon receipt plus container ID, name, run-id label, and scope
label created by this invocation.
