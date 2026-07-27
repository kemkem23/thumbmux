/**
 * Bun test preload for real Svelte 5 mount tests.
 *
 * 1. Registers a Bun plugin that compiles:
 *    - `*.svelte` via svelte/compiler `compile` (client, CSS injected)
 *    - `*.svelte.ts` / `*.svelte.js` via Bun.Transpiler (strip types) +
 *      `compileModule` (runes → client JS)
 *    Bare `from "svelte"` is rewritten to the absolute client entry so mount
 *    works without a global `--conditions=browser` flag.
 * 2. Installs happy-dom browser globals ONLY when the invoked test path looks
 *    like the svelte suite. Package-wide happy-dom would overwrite Bun's
 *    Headers/Request via `globalThis.window` and break server tests.
 *
 * Wired from packages/thumbmux/bunfig.toml `[test].preload` so the plugin is
 * registered before any test file's static `.svelte` imports resolve (Bun
 * loads test files in parallel — an in-file `import "./preload"` is too late
 * when the suite runs together).
 */
import { plugin } from "bun";
import { compile, compileModule } from "svelte/compiler";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const g = globalThis as typeof globalThis & Record<string, unknown>;

const require = createRequire(import.meta.url);
const sveltePkgPath = require.resolve("svelte/package.json");
const svelteClientEntry = join(dirname(sveltePkgPath), "src/index-client.js");

/** Rewrite bare `svelte` imports to the client entry (mount/unmount/onMount). */
function rewriteSvelteBareImports(code: string): string {
  return code
    .replaceAll(/from\s*["']svelte["']/g, `from ${JSON.stringify(svelteClientEntry)}`)
    .replaceAll(/import\s*["']svelte["']/g, `import ${JSON.stringify(svelteClientEntry)}`);
}

/**
 * Detect svelte-suite runs so we do not install happy-dom for core/server.
 * Matches: `bun test ./svelte/tests/...`, absolute paths containing `/svelte/tests/`.
 */
function shouldInstallDom(): boolean {
  return process.argv.some(
    (arg) =>
      arg.includes("svelte/tests") ||
      arg.includes("svelte\\tests") ||
      arg.endsWith("mount-smoke.test.ts"),
  );
}

async function installHappyDom(): Promise<void> {
  if ((g as { __thumbmuxDomReady?: boolean }).__thumbmuxDomReady) return;

  const { Window } = await import("happy-dom");
  const happyWindow = new Window({ url: "http://localhost/" });

  // Do NOT assign globalThis.window = happyWindow for every property blindly —
  // overwriting Bun-native Headers/Request/fetch breaks server HTTP tests.
  // Install only the DOM surface Svelte mount + TermView need.
  const assign = (key: string, value: unknown): void => {
    try {
      g[key] = value;
    } catch {
      // ignore non-configurable
    }
  };

  assign("document", happyWindow.document);
  // Keep a window reference for code that reads window.location / etc., but
  // re-expose Bun's network primitives on it so accidental window.Headers works.
  const networkKeys = [
    "Headers",
    "Request",
    "Response",
    "fetch",
    "FormData",
    "Blob",
    "File",
    "AbortController",
    "AbortSignal",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "TextEncoder",
    "TextDecoder",
  ] as const;
  for (const key of networkKeys) {
    const bunValue = g[key];
    if (bunValue !== undefined) {
      try {
        (happyWindow as unknown as Record<string, unknown>)[key] = bunValue;
      } catch {
        // ignore
      }
    }
  }
  assign("window", happyWindow);
  assign("self", g);

  const ctorKeys = [
    "HTMLElement",
    "HTMLMediaElement",
    "HTMLVideoElement",
    "HTMLAudioElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLDivElement",
    "HTMLSpanElement",
    "HTMLParagraphElement",
    "HTMLTextAreaElement",
    "HTMLFormElement",
    "HTMLLabelElement",
    "HTMLFieldSetElement",
    "HTMLLegendElement",
    "HTMLAnchorElement",
    "HTMLSelectElement",
    "HTMLOptionElement",
    "HTMLTemplateElement",
    "HTMLUnknownElement",
    "Element",
    "Node",
    "DocumentFragment",
    "Text",
    "Comment",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "FocusEvent",
    "InputEvent",
    "PointerEvent",
    "WheelEvent",
    "TouchEvent",
    "MutationObserver",
    "ResizeObserver",
    "DOMParser",
    "NodeFilter",
    "Range",
    "CSSStyleSheet",
    "Document",
    "SVGElement",
    "Image",
    "HTMLCollection",
    "NodeList",
    "DOMTokenList",
    "NamedNodeMap",
    "Attr",
    "CharacterData",
  ] as const;

  for (const key of ctorKeys) {
    const value = (happyWindow as unknown as Record<string, unknown>)[key];
    if (value !== undefined) assign(key, value);
  }

  assign("navigator", happyWindow.navigator);
  assign("location", happyWindow.location);
  assign("history", happyWindow.history);
  assign("localStorage", happyWindow.localStorage);
  assign("sessionStorage", happyWindow.sessionStorage);
  assign("getComputedStyle", happyWindow.getComputedStyle.bind(happyWindow));
  assign("requestAnimationFrame", happyWindow.requestAnimationFrame.bind(happyWindow));
  assign("cancelAnimationFrame", happyWindow.cancelAnimationFrame.bind(happyWindow));
  // Prefer Bun's WebSocket when present so other suites keep their mocks; fall
  // back to happy-dom's for TermView subscribe attempts under mount smoke.
  if (typeof g.WebSocket !== "function") {
    assign("WebSocket", happyWindow.WebSocket);
  }
  assign("isSecureContext", true);

  if (typeof g.matchMedia !== "function") {
    assign("matchMedia", () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }));
  }

  if (!g.visualViewport) {
    assign("visualViewport", {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener() {},
      removeEventListener() {},
    });
  }

  try {
    Object.defineProperty(happyWindow.document, "defaultView", {
      configurable: true,
      get: () => happyWindow,
    });
  } catch {
    // ignore
  }

  (g as { __thumbmuxDomReady?: boolean }).__thumbmuxDomReady = true;
}

if (!(g as { __thumbmuxSveltePlugin?: boolean }).__thumbmuxSveltePlugin) {
  plugin({
    name: "thumbmux-svelte-loader",
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const result = compile(source, {
          filename: args.path,
          generate: "client",
          css: "injected",
          dev: true,
        });
        return {
          contents: rewriteSvelteBareImports(result.js.code),
          loader: "js",
        };
      });

      build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, (args) => {
        let source = readFileSync(args.path, "utf8");
        if (args.path.endsWith(".ts")) {
          source = new Bun.Transpiler({
            loader: "ts",
            target: "browser",
          }).transformSync(source);
        }
        const result = compileModule(source, {
          filename: args.path,
          generate: "client",
          dev: true,
        });
        return {
          contents: rewriteSvelteBareImports(result.js.code),
          loader: "js",
        };
      });
    },
  });
  (g as { __thumbmuxSveltePlugin?: boolean }).__thumbmuxSveltePlugin = true;
}

if (shouldInstallDom()) {
  await installHappyDom();
}
