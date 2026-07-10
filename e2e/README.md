# thumbmux package demo e2e

The Playwright suite drives the package demo and real tmux sessions inside one
disposable container. The canonical runner creates a unique container, asks
Docker for an ephemeral localhost port, performs a frozen install, waits for
the authenticated demo to answer, runs every `e2e/*.spec.ts`, and removes the
container on success, failure, or interruption.

The specs only create sessions whose names begin with `sim-` and clean up each
session after the test.

## Run the complete suite

From the package root:

```bash
bun install --frozen-lockfile
./node_modules/.bin/playwright install --with-deps chromium
./e2e/run-container.sh
```

Docker, curl, tar, Bun, and the local Playwright Chromium installation are
required on the host. Test traces, screenshots, the Playwright log, and a
token-redacted demo log are retained in the artifacts directory printed by
the runner.

## Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `THUMBMUX_E2E_ARTIFACTS` | `$TMPDIR/<container>-artifacts` | Artifact output directory |
| `THUMBMUX_E2E_IMAGE` | `oven/bun:1` | Disposable container image |
| `THUMBMUX_E2E_READY_TIMEOUT` | `90` | Demo readiness timeout in seconds |
| `THUMBMUX_CONTAINER` | Unique run-specific name | Explicit runner-owned container name |
| `THUMBMUX_HOST_PORT` | Docker-assigned localhost port | Fixed host port when needed |
| `THUMBMUX_DEMO_PORT` | `7681` | Demo port inside the container |
| `THUMBMUX_PACKAGE_DIR` | Parent of this directory | Alternate package checkout |
| `THUMBMUX_PLAYWRIGHT_BIN` | `node_modules/.bin/playwright` | Alternate local Playwright executable |

An explicitly supplied container name is still owned and removed by this
runner. Do not point it at a container that should remain alive.
