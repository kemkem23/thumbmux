# README screenshots

These ten PNGs are **regenerated**, not hand-taken. They are produced by
`scripts/capture-media.sh` from the package demo running inside a blank
container. Do not replace a file by photographing your laptop.

The previous set was captured on 2026-07-09 against v0.3.3. There was no
script, so nothing failed when the pictures went stale.

## Why a container

`demo/serve.ts` attaches `TmuxWsMux` to **whatever tmux the process can see**.
On the kemcortex host that is the live agent fleet. Capturing there and
shipping the PNGs in the public tarball would leak other people's sessions.

The capture harness starts a disposable `oven/bun:1` image, installs tmux and
htop *inside it*, copies this package tree in, stages exactly four sessions
(`agent`, `build`, `htop`, `server-logs`), and publishes an ephemeral
localhost port. Playwright on the host drives that port. The run **fails** if
the hub shows any session name outside those four.

The host's tmux server is never started, listed for mutation, or killed.

## Re-run

From this package root, on a machine with Docker, Bun, and local Playwright
Chromium:

```bash
bun install --frozen-lockfile
./node_modules/.bin/playwright install chromium
./scripts/capture-media.sh
```

One command. No manual clicks. The ten files under this directory are
overwritten in place. The script then removes the container, drops `/tmp`
scratch, and checks that `docker ps -a` and the host `tmux ls` match the
snapshot it took before it started.

`?media=1` on the demo URL is the capture hook: it is how the host supplies
the one-line hub `subtitle` (a v0.12.0 host-owned field). The default demo is
unchanged.

## The ten files

| file | viewport (CSS px × 2) | contents |
|---|---|---|
| `hero.png` | three 390×664 panels | `agent` in dark, deep blue, cream |
| `hub.png` | 390×664 | four live cards + `+ terminal` |
| `launcher.png` | 390×664 | launch sheet, presets, both dropdowns |
| `term-agent.png` | 390×664 | coloured diff, tests, tappable URL |
| `composer.png` | 390×664 | composer dock open, tail still visible |
| `shortcuts.png` | 390×664 | shortcut manager sheet |
| `theme.png` | 390×664 | theme sheet: dark/light, swatches, Pick |
| `term-cream.png` | 390×664 | the same session in cream |
| `desktop-agent.png` | 1440×860 | desktop width, with composer |
| `desktop-htop.png` | 1440×860 | real htop (alt-screen SGR mouse) |

Keep the file names. `README.md` at the package root references each path;
renaming one silently breaks the public page.

File sizes should stay in the same neighbourhood as the previous set
(roughly 40–700 KB). They ship inside the npm tarball.
