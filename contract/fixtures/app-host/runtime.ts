/*
 * FROZEN CONSUMER FIXTURE (RULES §9).
 * Changes require a matching contract manifest change and the CONTRACT.md
 * deprecation procedure.
 */
import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createAppRoutes,
  createBunTmuxDriver,
  killTmuxSession,
  spawnTmuxSession,
} from "thumbmux/server";

const FIXTURE = "app-host";
const SESSION_PREFIX = "ctrfix-app";
const MIN_EXTRA_ENTER_DELAY_MS = 800;
const PANE_WAIT_MS = 10_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function receiptFor(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hasSession(name: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", `=${name}`]).exitCode === 0;
}

function capturePane(name: string): string {
  const capture = Bun.spawnSync([
    "tmux",
    "capture-pane",
    "-t",
    `=${name}:`,
    "-p",
    "-S",
    "-100",
  ]);
  if (capture.exitCode !== 0) {
    throw new Error(capture.stderr.toString().trim() || `failed to capture ${name}`);
  }
  return capture.stdout.toString();
}

async function waitForPane(
  name: string,
  predicate: (pane: string) => boolean,
  failure: string,
): Promise<string> {
  const deadline = Date.now() + PANE_WAIT_MS;
  let pane = "";
  while (Date.now() < deadline) {
    pane = capturePane(name);
    if (predicate(pane)) return pane;
    await Bun.sleep(25);
  }
  throw new Error(`${failure}\n${pane}`);
}

async function listenerIsClosed(origin: string): Promise<boolean> {
  try {
    await fetch(origin, {
      cache: "no-store",
      signal: AbortSignal.timeout(500),
    });
    return false;
  } catch {
    return true;
  }
}

function paneProbeSource(): string {
  return [
    "/*",
    " * FROZEN CONSUMER FIXTURE (RULES §9).",
    " * Changes require a matching contract manifest change and the CONTRACT.md",
    " * deprecation procedure.",
    " */",
    'import { createInterface } from "node:readline";',
    "",
    "function receiptFor(value) {",
    "  let hash = 0x811c9dc5;",
    "  for (let index = 0; index < value.length; index += 1) {",
    "    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);",
    "  }",
    '  return (hash >>> 0).toString(16).padStart(8, "0");',
    "}",
    "",
    "let state = 0;",
    "let firstEnterAt = 0;",
    "const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });",
    'console.log("CTR_PROBE_READY");',
    'lines.on("line", (line) => {',
    "  if (state === 0) {",
    "    state = 1;",
    "    firstEnterAt = performance.now();",
    '    console.log("CTR_COMPOSER_RECEIPT=" + receiptFor(line));',
    "    return;",
    "  }",
    "  if (state === 1) {",
    "    state = 2;",
    "    const elapsed = Math.round(performance.now() - firstEnterAt);",
    "    if (line.length === 0) {",
    '      console.log("CTR_DELAYED_ENTER_MS=" + elapsed);',
    "    } else {",
    '      console.log("CTR_SECOND_LINE_RECEIPT=" + receiptFor(line));',
    "    }",
    "  }",
    "});",
    "",
  ].join("\n");
}

const fixtureRoot = import.meta.dir;
const distRoot = resolve(fixtureRoot, "dist");
const runtimeRoot = await mkdtemp(join(tmpdir(), "thumbmux-app-contract-"));
const probePath = join(runtimeRoot, "pane-probe.mjs");
const sessionName = `${SESSION_PREFIX}-${process.pid}-${Date.now()}`;
const marker = `CTR_APP_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
const expectedReceipt = receiptFor(marker);
const driver = createBunTmuxDriver();
const routes = createAppRoutes({
  driver,
  archive: null,
  spawn: false,
  upload: false,
  prefs: false,
  kill: { enabled: false },
  mux: {
    pollNormalMs: 40,
    pollBurstMs: 20,
    pollReconcileMs: 40,
    sessionListIntervalMs: 40,
  },
});

let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let origin: string | null = null;
let failure: unknown = null;
let hubRendered = false;
let sessionOpened = false;
let markerCaptured = false;
let receiptMatched = false;
let delayedEnterMs: number | null = null;

try {
  await Bun.write(probePath, paneProbeSource());
  spawnTmuxSession(
    sessionName,
    runtimeRoot,
    `exec bun ${shellQuote(probePath)}`,
  );
  assert(hasSession(sessionName), "real tmux session was not created");
  await waitForPane(
    sessionName,
    (pane) => pane.includes("CTR_PROBE_READY"),
    "tmux pane probe did not become ready",
  );

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const routed = await routes.fetch(request, bunServer);
      if (routed) return routed;

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 });
      }
      const url = new URL(request.url);
      let relativePath: string;
      try {
        relativePath = decodeURIComponent(
          url.pathname === "/" ? "index.html" : url.pathname.slice(1),
        );
      } catch {
        return new Response("bad path", { status: 400 });
      }
      const filePath = resolve(distRoot, relativePath);
      if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) {
        return new Response("not found", { status: 404 });
      }
      const file = Bun.file(filePath);
      if (!await file.exists()) return new Response("not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "cache-control": "no-store",
          ...(file.type ? { "content-type": file.type } : {}),
        },
      });
    },
    websocket: routes.websocket,
  });
  origin = `http://127.0.0.1:${server.port}`;

  const executablePath = process.env.CHROMIUM_PATH?.trim();
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  const hub = page.locator('[data-testid="hub-view"]');
  await hub.waitFor({ state: "visible", timeout: 10_000 });
  const hubTitle = (await page.locator('[data-testid="hub-title"]').textContent())?.trim();
  assert(hubTitle === "TERMINALS", `unexpected hub title: ${hubTitle ?? "missing"}`);

  const card = page.locator(
    `[data-testid="grid-card"][data-session="${sessionName}"]`,
  );
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.locator('[data-testid="session-thumb"][data-live="true"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });
  hubRendered = true;

  await page.evaluate((name) => {
    const currentCard = document.querySelector(
      `[data-testid="grid-card"][data-session="${CSS.escape(name)}"]`,
    );
    if (!(currentCard instanceof HTMLButtonElement)) {
      throw new Error(`session card disappeared: ${name}`);
    }
    currentCard.click();
  }, sessionName);
  await page.locator('[data-testid="session-view"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });
  sessionOpened = new URL(page.url()).searchParams.get("session") === sessionName;
  assert(sessionOpened, "hub did not navigate to the real tmux session");

  await page.locator('button[aria-label="Actions"]').click();
  const typeAction = page.locator(".slots.open .slot").first();
  await typeAction.waitFor({ state: "visible", timeout: 5_000 });
  await typeAction.click();
  const composer = page.locator('[data-testid="input-sheet"].open');
  await composer.waitFor({ state: "visible", timeout: 5_000 });
  await composer.locator("textarea").fill(marker);
  await composer.locator("button.snd").click();

  const receiptLine = `CTR_COMPOSER_RECEIPT=${expectedReceipt}`;
  const pane = await waitForPane(
    sessionName,
    (value) => value.includes(receiptLine) && value.includes("CTR_DELAYED_ENTER_MS="),
    "composer did not deliver both planned Enter steps",
  );
  markerCaptured = pane.includes(marker);
  receiptMatched = pane.includes(receiptLine);
  const delayMatch = [...pane.matchAll(/CTR_DELAYED_ENTER_MS=(\d+)/g)].at(-1);
  delayedEnterMs = delayMatch ? Number(delayMatch[1]) : null;

  assert(markerCaptured, "composer marker was not present in the real tmux pane");
  assert(receiptMatched, "pane process did not compute the expected composer receipt");
  assert(
    delayedEnterMs !== null && delayedEnterMs >= MIN_EXTRA_ENTER_DELAY_MS,
    `agent-specific Enter delay was ${delayedEnterMs ?? "missing"}ms`,
  );
} catch (error) {
  failure = error;
}

const cleanupErrors: string[] = [];
let browserClosed = browser === null;
let serverClosed = server === null;
let listenerClosed = origin === null;

if (browser) {
  try {
    await browser.close();
    browserClosed = true;
  } catch (error) {
    cleanupErrors.push(`browser close: ${errorMessage(error)}`);
  }
}

try {
  routes.mux.stop();
} catch (error) {
  cleanupErrors.push(`mux stop: ${errorMessage(error)}`);
}

if (server) {
  try {
    await server.stop(true);
    serverClosed = true;
  } catch (error) {
    cleanupErrors.push(`server stop: ${errorMessage(error)}`);
  }
}

if (origin) {
  listenerClosed = await listenerIsClosed(origin);
  if (!listenerClosed) cleanupErrors.push(`listener still accepts requests at ${origin}`);
}

try {
  if (hasSession(sessionName)) killTmuxSession(sessionName);
} catch (error) {
  cleanupErrors.push(`tmux cleanup: ${errorMessage(error)}`);
}
const sessionRemoved = !hasSession(sessionName);
if (!sessionRemoved) cleanupErrors.push(`tmux session still exists: ${sessionName}`);

try {
  await rm(runtimeRoot, { recursive: true, force: true });
} catch (error) {
  cleanupErrors.push(`temporary directory cleanup: ${errorMessage(error)}`);
}

const summary = {
  fixture: FIXTURE,
  status: failure || cleanupErrors.length > 0 ? "failed" : "passed",
  hubRendered,
  sessionOpened,
  markerCaptured,
  receiptMatched,
  delayedEnterMs,
  cleanup: {
    browserClosed,
    serverClosed,
    listenerClosed,
    sessionRemoved,
    errors: cleanupErrors,
  },
};
console.log(JSON.stringify(summary));

if (failure) throw failure;
if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
