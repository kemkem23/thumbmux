/**
 * TM-04, the half that only a layout engine can answer: the session name must
 * never lose the row to the slot beside it.
 *
 * The consumer report measured the failure precisely — with `status` pressed
 * into service as an inline badge at a 390px bar, `.nm` had clientWidth 15px
 * against scrollWidth 187px: the name clipped to its caret glyph. happy-dom
 * reports every width as 0, so the whole of that finding is invisible to the
 * suite that runs everywhere else. This file drives real Chromium.
 *
 * It also carries its own control. Each width assertion is paired with the same
 * measurement taken while the collapse rule is neutralized by a stylesheet
 * override — if the harness were not really laying out, the control could not
 * reproduce the crush, and the test would fail rather than pass vacuously.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { readFileSync, rmSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Compile the real component — not a re-creation of it. A layout test that
 * measures a hand-written copy of the markup proves only that the copy is
 * consistent with itself. */
const sveltePlugin: import("bun").BunPlugin = {
  name: "thumbmux-svelte-browser",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, (args) => ({
      contents: compile(readFileSync(args.path, "utf8"), {
        filename: args.path,
        generate: "client",
        css: "injected",
      }).js.code,
      loader: "js",
    }));
  },
};

const HUD_VARS = `
  --font-mono: ui-monospace, "DejaVu Sans Mono", monospace;
  --font-thai: ui-sans-serif, sans-serif;
  --hud: rgba(0,0,0,.35); --tbg: #111; --tstage: #111;
  --hud-fg: #eee; --hud-line: #444; --agent: #f60;
`;

/** Neutralize only the collapse, leaving every other rule in place: this is the
 * layout the row would have if the slot competed for width instead of yielding
 * — i.e. exactly what the consumer measured. */
const NEUTRALIZE_COLLAPSE = `
  .nm-slot-collapsed {
    position: static !important; visibility: visible !important; max-width: none !important;
  }
`;

type Measurement = {
  nmWidth: number;
  titleClientWidth: number;
  titleScrollWidth: number;
  caretWidth: number;
  gap: number;
  collapsed: string | null;
  slotOffsetWidth: number;
  slotVisibility: string;
  slotFontSize: string;
  nmFontSize: string;
  slotTextTransform: string;
  slotText: string;
};

let browser: Browser;
let bundle: string;

// Generated next to the tests, not in a temp dir: the entry imports `svelte`,
// and Node resolution walks up from the importing file — from /tmp there is no
// node_modules to find. Dot-prefixed so it never matches the `*.test.ts` glob.
const ENTRY = join(here, ".term-hud-browser-entry.generated.ts");

beforeAll(async () => {
  await Bun.write(
    ENTRY,
    `
import { mount, createRawSnippet } from "svelte";
import TermHud from ${JSON.stringify(join(here, "../src/TermHud.svelte"))};

const cfg = window.__hudProps ?? {};
const props = { chip: "CC", title: cfg.title, status: "working", onBack() {} };
if (cfg.adorn) {
  props.titleAdornment = createRawSnippet(() => ({
    render: () => '<span class="host-chip">' + cfg.adorn + '</span>',
  }));
}
mount(TermHud, { target: document.getElementById("app"), props });
window.__hudReady = true;
`,
  );

  const built = await Bun.build({
    entrypoints: [ENTRY],
    plugins: [sveltePlugin],
    target: "browser",
    minify: false,
  });
  if (!built.success) {
    throw new Error(`bundle failed: ${built.logs.map(String).join("\n")}`);
  }
  bundle = await built.outputs[0]!.text();

  const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  rmSync(ENTRY, { force: true });
});

async function render(
  page: Page,
  opts: { width: number; title: string; adorn: string; extraCss?: string },
): Promise<Measurement> {
  // Props are handed over by a classic script before the module script, which
  // is deferred by definition — a `setContent` page has no URL to read them
  // from and no reload that would survive one.
  await page.setContent(
    `<!doctype html><html><head><style>
       * { box-sizing: border-box; }
       body { margin: 0; ${HUD_VARS} }
       #app { position: relative; width: ${opts.width}px; }
       .host-chip { font: inherit; }
       ${opts.extraCss ?? ""}
     </style></head><body><div id="app"></div>
     <script>window.__hudProps = ${JSON.stringify({ title: opts.title, adorn: opts.adorn })};</script>
     <script type="module">${bundle.replaceAll("</script", "<\\/script")}</script>
     </body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => (window as unknown as { __hudReady?: boolean }).__hudReady);
  // One settled frame: the first measurement runs in an effect after mount, and
  // a collapse decision made there lands on the next paint.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return page.evaluate(() => {
    const nm = document.querySelector(".nm") as HTMLElement;
    const title = document.querySelector(".nm-title") as HTMLElement;
    const slot = document.querySelector('[data-testid="hud-title-adornment"]') as HTMLElement;
    const caret = document.querySelector(".hud-caret") as HTMLElement;
    const cs = getComputedStyle(slot);
    return {
      nmWidth: nm.clientWidth,
      titleClientWidth: title.clientWidth,
      titleScrollWidth: title.scrollWidth,
      caretWidth: caret.offsetWidth,
      gap: Number.parseFloat(getComputedStyle(nm).columnGap) || 0,
      collapsed: slot.getAttribute("data-collapsed"),
      slotOffsetWidth: slot.offsetWidth,
      slotVisibility: cs.visibility,
      slotFontSize: cs.fontSize,
      nmFontSize: getComputedStyle(nm).fontSize,
      slotTextTransform: cs.textTransform,
      slotText: slot.textContent ?? "",
    };
  });
}

const TIGHT = { width: 390, title: "term-3fsy9c-orchestrator", adorn: "queued · 12m48s · build 4 of 6" };
const ROOMY = { width: 1100, title: "term-a1", adorn: "2m14s" };

/** The name gets what it needs, up to everything the caret does not take. It is
 * not "the name fills the row" — a name shorter than the row still ends where
 * it ends. What must never happen is a name given less than that because
 * something else on the row was served first. */
function expectNameKeptTheRow(m: Measurement): void {
  const entitled = Math.min(m.titleScrollWidth, m.nmWidth - m.caretWidth - m.gap);
  expect(m.titleClientWidth).toBeGreaterThanOrEqual(entitled - 1);
}

describe("TM-04 · the name keeps the row", () => {
  test(
    "when the slot cannot fit beside the name, it leaves and the name keeps the whole row",
    async () => {
      const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
      try {
        const fixed = await render(page, TIGHT);
        expect(fixed.collapsed).toBe("true");
        expect(fixed.slotVisibility).toBe("hidden");

        expectNameKeptTheRow(fixed);
        // This case is the consumer's own: at 390px the name fits on its own
        // (173px of 213px available) and only stops fitting once a 29-character
        // badge is served first. With the badge gone it is not merely readable,
        // it is not even ellipsised.
        expect(fixed.titleClientWidth).toBeGreaterThanOrEqual(fixed.titleScrollWidth);

        // Control: same page, same widths, collapse rule neutralized. This is
        // the v0.13.1 behaviour the consumer measured.
        const crushed = await render(page, { ...TIGHT, extraCss: NEUTRALIZE_COLLAPSE });
        expect(crushed.slotOffsetWidth).toBeGreaterThan(0);
        expect(crushed.titleClientWidth).toBeLessThan(fixed.titleClientWidth * 0.6);
        expect(crushed.titleClientWidth).toBeLessThan(crushed.titleScrollWidth);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  test(
    "when there is room, the slot renders inline at the name's own font size",
    async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
      try {
        const m = await render(page, ROOMY);
        expect(m.collapsed).toBe("false");
        expect(m.slotVisibility).toBe("visible");
        expect(m.slotOffsetWidth).toBeGreaterThan(0);
        // The name is not clipped — both are fully readable, which is the point.
        expect(m.titleClientWidth).toBeGreaterThanOrEqual(m.titleScrollWidth);
        expect(m.slotFontSize).toBe(m.nmFontSize);
        expect(m.slotTextTransform).toBe("none");
        expect(m.slotText).toBe("2m14s");
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  test(
    "the row keeps deciding after first paint — narrowing it collapses the slot",
    async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
      try {
        const wide = await render(page, { ...ROOMY, title: "term-3fsy9c-orchestrator" });
        expect(wide.collapsed).toBe("false");

        const after = await page.evaluate(async () => {
          (document.getElementById("app") as HTMLElement).style.width = "300px";
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const slot = document.querySelector('[data-testid="hud-title-adornment"]') as HTMLElement;
          const nm = document.querySelector(".nm") as HTMLElement;
          const title = document.querySelector(".nm-title") as HTMLElement;
          const caret = document.querySelector(".hud-caret") as HTMLElement;
          return {
            collapsed: slot.getAttribute("data-collapsed"),
            titleClientWidth: title.clientWidth,
            titleScrollWidth: title.scrollWidth,
            nmWidth: nm.clientWidth,
            caretWidth: caret.offsetWidth,
            gap: Number.parseFloat(getComputedStyle(nm).columnGap) || 0,
          };
        });
        expect(after.collapsed).toBe("true");
        expectNameKeptTheRow(after as Measurement);
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
