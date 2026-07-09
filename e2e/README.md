# thumbmux package demo e2e

These Playwright specs drive the package demo against tmux sessions inside a disposable container. The suite only creates sessions whose names begin with `sim-` and kills those sessions after each test.

## Container recipe

Replace the placeholder values with local choices before running:

```bash
export THUMBMUX_CONTAINER=thumbmux-sim
export THUMBMUX_HOST_PORT=<host-port>
export THUMBMUX_DEMO_PORT=<demo-port>
export THUMBMUX_PACKAGE_DIR=<path-to-this-package>

docker rm -f "$THUMBMUX_CONTAINER" 2>/dev/null || true
docker run -d --name "$THUMBMUX_CONTAINER" -p "${THUMBMUX_HOST_PORT}:${THUMBMUX_DEMO_PORT}" oven/bun:1 sleep infinity
docker exec "$THUMBMUX_CONTAINER" bash -lc 'apt-get update -qq && apt-get install -y -qq tmux procps'
tar -C "$THUMBMUX_PACKAGE_DIR" --exclude=node_modules --exclude='*/node_modules' --exclude=dist -cf - . | docker exec -i "$THUMBMUX_CONTAINER" bash -lc 'mkdir -p /app && tar -C /app -xf -'
docker exec "$THUMBMUX_CONTAINER" bash -lc 'cd /app && bun install'
docker exec -d "$THUMBMUX_CONTAINER" bash -lc 'cd /app && bun run demo -- --host >/tmp/demo.log 2>&1'
docker exec "$THUMBMUX_CONTAINER" bash -lc "grep -oE 't=[a-f0-9]+' /tmp/demo.log | head -1"
```

Set `DEMO_URL` to the printed demo URL before running the tests.

## Test command

From this directory:

```bash
NODE_PATH="$NODE_PATH" DEMO_URL="$DEMO_URL" THUMBMUX_CONTAINER="${THUMBMUX_CONTAINER:-thumbmux-sim}" npx playwright test --config=playwright.config.ts
```

The config is scoped to this directory and reads its base URL from `DEMO_URL`. Chromium clipboard tests require the normal Playwright browser installation.
