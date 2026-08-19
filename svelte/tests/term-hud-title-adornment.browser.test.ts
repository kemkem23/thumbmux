/**
 * Real-layout coverage for TermHud metadata and the dense SessionGrid. The
 * session name must never lose the row to the slot beside it, and dense cards
 * must honor pointer-aware geometry that happy-dom cannot calculate.
 *
 * The consumer report measured the failure precisely — with `status` pressed
 * into service as an inline badge at a 390px bar, `.nm` had clientWidth 15px
 * against scrollWidth 187px: the name clipped to its caret glyph. happy-dom
 * reports every width as 0, so the whole of that finding is invisible to the
 * suite that runs everywhere else. This file drives real Chromium.
 *
 * The HUD suite carries its own control. Each width assertion is paired with the same
 * measurement taken while the collapse rule is neutralized by a stylesheet
 * override — if the harness were not really laying out, the control could not
 * reproduce the crush, and the test would fail rather than pass vacuously.
 * SessionThumb alone is stubbed because its wire/ANSI behavior has dedicated
 * tests; the real SessionGrid markup and CSS still own every measured card.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { readFileSync, rmSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Compile the real component — not a re-creation of it. A layout test that
 * measures a hand-written copy of the markup proves only that the copy is
 * consistent with itself. */
const sveltePlugin: import("bun").BunPlugin = {
  name: "thumbmux-svelte-browser",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, (args) => {
      const source = args.path.endsWith("/SessionThumb.svelte")
        ? `<script>let { density = 'default' } = $props();</script>
           <div data-testid="session-thumb" class:dense={density === 'dense'}><div class="tail"></div></div>`
        : readFileSync(args.path, "utf8");
      return {
      contents: compile(source, {
        filename: args.path,
        generate: "client",
        css: "injected",
      }).js.code,
      loader: "js",
    };
    });
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
import SessionGrid from ${JSON.stringify(join(here, "../src/SessionGrid.svelte"))};

const cfg = window.__hudProps ?? {};
if (cfg.component === "grid") {
  const palette = {
    defaultFg: "#eeeeee",
    defaultBg: "#111111",
    base: Array.from({ length: 16 }, (_, index) => index % 2 ? "#eeeeee" : "#111111"),
  };
  const sessions = [
    { name: "codex-dense-alpha-very-long-name", note: "โน้ตหลายบรรทัดสำหรับผู้ดูแลที่มีรายละเอียดต่อเนื่องยาวพอให้เกินสองบรรทัดของการ์ด", summary: "กำลังรัน browser integration tests ชุดใหญ่ พร้อมตรวจ responsive layout, clipboard separation และ regression cases อีกหลายรายการ" },
    { name: "grok-dense-beta", note: "รอ input", summary: "สรุปงานล่าสุดของ session" },
  ];
  window.__denseOpened = [];
  mount(SessionGrid, {
    target: document.getElementById("app"),
    props: {
      sessions,
      palette,
      onOpen(name) { window.__denseOpened.push(name); },
      onNew() {},
      cardLayout: "dense",
      showNew: false,
    },
  });
} else {
  const props = {
    chip: "CC",
    title: cfg.title,
    status: "working",
    note: cfg.note,
    layout: cfg.layout,
    onBack() {},
  };
  if (cfg.adorn) {
    props.titleAdornment = createRawSnippet(() => ({
      render: () => '<span class="host-chip">' + cfg.adorn + '</span>',
    }));
  }
  mount(TermHud, { target: document.getElementById("app"), props });
}
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
     <script>window.__hudProps = ${JSON.stringify({ title: opts.title, adorn: opts.adorn })};
       // Cleared here rather than trusted to be absent: if setContent ever reuses
       // the window, a stale flag would let the wait return before this document's
       // mount had run, and the control would silently measure the previous page.
       window.__hudReady = false;</script>
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

type DenseMeasurement = {
  order: string[];
  hudHeight: number;
  hudClientWidth: number;
  hudScrollWidth: number;
  titleHeight: number;
  titleLineCount: number;
  titleMinWidth: string;
  titleWhiteSpace: string;
  fieldsFlexWrap: string;
  adornCollapsed: string | null;
  adornVisibility: string;
  noteLineClamp: string;
  noteClientHeight: number;
  noteScrollHeight: number;
  noteLineHeight: number;
  adornLineClamp: string;
  adornClientHeight: number;
  adornScrollHeight: number;
  adornLineHeight: number;
  expandRight: number;
  hudRight: number;
  backgroundImage: string;
  statusCount: number;
  chipDisplay: string;
};

async function renderDense(
  page: Page,
  opts: { width: number; title: string; note: string; adorn: string },
): Promise<DenseMeasurement> {
  await page.setContent(
    `<!doctype html><html><head><style>
       * { box-sizing: border-box; }
       body { margin: 0; ${HUD_VARS} }
       #app { position: relative; width: ${opts.width}px; }
       .host-chip { font: inherit; }
     </style></head><body><div id="app"></div>
     <script>window.__hudProps = ${JSON.stringify({
       title: opts.title,
       note: opts.note,
       adorn: opts.adorn,
       layout: "dense",
     })}; window.__hudReady = false;</script>
     <script type="module">${bundle.replaceAll("</script", "<\\/script")}</script>
     </body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => (window as unknown as { __hudReady?: boolean }).__hudReady);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>(".hud-top")!;
    const fields = document.querySelector<HTMLElement>('[data-testid="hud-dense-fields"]')!;
    const title = document.querySelector<HTMLElement>('[data-testid="hud-copy-title"]')!;
    const note = document.querySelector<HTMLElement>(".hud-note-dense")!;
    const adorn = document.querySelector<HTMLElement>('[data-testid="hud-title-adornment"]')!;
    const expand = document.querySelector<HTMLElement>('[data-testid="hud-expand"]')!;
    const hudRect = hud.getBoundingClientRect();
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title);
    const titleStyle = getComputedStyle(title);
    const noteStyle = getComputedStyle(note);
    const adornStyle = getComputedStyle(adorn);
    const resolvedLineHeight = (style: CSSStyleDeclaration) =>
      Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.7;
    return {
      order: Array.from(fields.children).map((element) => element.className.split(" ")[0]),
      hudHeight: hudRect.height,
      hudClientWidth: hud.clientWidth,
      hudScrollWidth: hud.scrollWidth,
      titleHeight: title.getBoundingClientRect().height,
      titleLineCount: titleRange.getClientRects().length,
      titleMinWidth: titleStyle.minWidth,
      titleWhiteSpace: titleStyle.whiteSpace,
      fieldsFlexWrap: getComputedStyle(fields).flexWrap,
      adornCollapsed: adorn.getAttribute("data-collapsed"),
      adornVisibility: adornStyle.visibility,
      noteLineClamp: noteStyle.getPropertyValue("-webkit-line-clamp"),
      noteClientHeight: note.clientHeight,
      noteScrollHeight: note.scrollHeight,
      noteLineHeight: resolvedLineHeight(noteStyle),
      adornLineClamp: adornStyle.getPropertyValue("-webkit-line-clamp"),
      adornClientHeight: adorn.clientHeight,
      adornScrollHeight: adorn.scrollHeight,
      adornLineHeight: resolvedLineHeight(adornStyle),
      expandRight: expand.getBoundingClientRect().right,
      hudRight: hudRect.right,
      backgroundImage: getComputedStyle(hud).backgroundImage,
      statusCount: document.querySelectorAll(".st").length,
      chipDisplay: getComputedStyle(document.querySelector<HTMLElement>(".agchip")!).display,
    };
  });
}

type CardMetrics = {
  width: number;
  height: number;
  top: number;
  left: number;
  borderRadius: string;
  backgroundImage: string;
  pageWidth: number;
  viewportWidth: number;
};

async function renderDenseGrid(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      * { box-sizing: border-box; }
      html, body, #app { margin: 0; width: 100%; min-height: 100%; }
      body {
        --font-mono: ui-monospace, "DejaVu Sans Mono", monospace;
        --font-thai: ui-sans-serif, sans-serif;
        --hub-card: #faf7f2; --hub-line: #1a1a1a;
        --hub-ink: #1a1a1a; --hub-ink2: #6b6560; --hub-accent: #c45200;
      }
    </style></head><body><div id="app"></div>
    <script>window.__hudProps = { component: "grid" }; window.__hudReady = false;</script>
    <script type="module">${bundle.replaceAll("</script", "<\\/script")}</script>
    </body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => (window as unknown as { __hudReady?: boolean }).__hudReady);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page;
}

async function gridMetrics(page: Page): Promise<CardMetrics[]> {
  return page.locator('[data-testid="grid-card"]').evaluateAll((cards) => cards.map((card) => {
    const element = card as HTMLElement;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      borderRadius: style.borderRadius,
      backgroundImage: style.backgroundImage,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  }));
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

describe("dense HUD browser layout", () => {
  test(
    "wraps all metadata without collapsing activity or overflowing the narrow bar",
    async () => {
      const page = await browser.newPage({ viewport: { width: 320, height: 500 } });
      try {
        const measurement = await renderDense(page, {
          width: 280,
          title: "codex-kemcortex-very-long-session-name-20260819",
          note: "โน้ตยาวที่ต้องขึ้นบรรทัดใหม่โดยไม่เว้นพื้นที่ฟุ่มเฟือย และยังมีรายละเอียดต่อเนื่องอีกหลายช่วงเพื่อพิสูจน์ว่าถูกจำกัดไว้สองบรรทัดจริง",
          adorn: "กำลังรัน browser integration tests ชุดใหญ่ พร้อมตรวจ responsive layout, clipboard separation, metadata wrapping และ regression cases อีกหลายรายการ",
        });
        expect(measurement.order).toEqual([
          "hud-copy-title",
          "hud-separator",
          "hud-note",
          "hud-separator",
          "hud-dense-adornment",
          "hud-separator",
          "hud-dense-expand",
        ]);
        expect(measurement.fieldsFlexWrap).toBe("wrap");
        expect(measurement.titleWhiteSpace).toBe("normal");
        expect(measurement.titleMinWidth).toBe("44px");
        expect(measurement.titleHeight).toBeGreaterThanOrEqual(44);
        expect(measurement.titleLineCount).toBeGreaterThan(1);
        expect(measurement.hudHeight).toBeGreaterThan(52);
        expect(measurement.hudScrollWidth).toBeLessThanOrEqual(measurement.hudClientWidth + 1);
        expect(measurement.expandRight).toBeLessThanOrEqual(measurement.hudRight + 1);
        expect(measurement.adornCollapsed).toBe("false");
        expect(measurement.adornVisibility).toBe("visible");
        expect(measurement.noteLineClamp).toBe("2");
        expect(measurement.noteClientHeight).toBeLessThanOrEqual(measurement.noteLineHeight * 2 + 1);
        expect(measurement.noteScrollHeight).toBeGreaterThan(measurement.noteClientHeight);
        expect(measurement.adornLineClamp).toBe("3");
        expect(measurement.adornClientHeight).toBeLessThanOrEqual(measurement.adornLineHeight * 3 + 1);
        expect(measurement.adornScrollHeight).toBeGreaterThan(measurement.adornClientHeight);
        expect(measurement.backgroundImage).toBe("none");
        expect(measurement.statusCount).toBe(0);
        expect(measurement.chipDisplay).toBe("none");
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});

describe("dense SessionGrid browser layout", () => {
  test("fine-pointer desktop renders exact 500x500 cards", async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    try {
      const page = await renderDenseGrid(context);
      expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
      const cards = await gridMetrics(page);
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        expect(card.width).toBe(500);
        expect(card.height).toBe(500);
        expect(card.borderRadius).toBe("0px");
        expect(card.backgroundImage).toBe("none");
        expect(card.pageWidth).toBeLessThanOrEqual(card.viewportWidth);
      }
      expect(Math.abs(cards[0]!.top - cards[1]!.top)).toBeLessThan(1);
      expect(cards[1]!.left - cards[0]!.left).toBe(508);
      expect(await page.locator('[data-testid="grid-new"]').count()).toBe(0);
      expect(await page.locator('[data-testid="grid-note"]').count()).toBe(2);
      expect(await page.locator('[data-testid="grid-summary"]').count()).toBe(2);
      expect(await page.locator('[data-testid="session-thumb"].dense').count()).toBe(2);
      const denseChrome = await page.locator('[data-testid="grid-card"]').first().evaluate((card) => {
        const copy = card.querySelector<HTMLElement>('[data-testid="grid-copy-name"]')!;
        const note = card.querySelector<HTMLElement>('[data-testid="grid-note"]')!;
        const summary = card.querySelector<HTMLElement>('[data-testid="grid-summary"]')!;
        const noteStyle = getComputedStyle(note);
        const summaryStyle = getComputedStyle(summary);
        return {
          copyMinWidth: getComputedStyle(copy).minWidth,
          noteLineClamp: noteStyle.getPropertyValue("-webkit-line-clamp"),
          noteHeight: note.clientHeight,
          noteLineHeight: Number.parseFloat(noteStyle.lineHeight),
          summaryLineClamp: summaryStyle.getPropertyValue("-webkit-line-clamp"),
          summaryHeight: summary.clientHeight,
          summaryLineHeight: Number.parseFloat(summaryStyle.lineHeight),
        };
      });
      expect(denseChrome.copyMinWidth).toBe("44px");
      expect(denseChrome.noteLineClamp).toBe("2");
      expect(denseChrome.noteHeight).toBeLessThanOrEqual(denseChrome.noteLineHeight * 2 + 1);
      expect(denseChrome.summaryLineClamp).toBe("3");
      expect(denseChrome.summaryHeight).toBeLessThanOrEqual(denseChrome.summaryLineHeight * 3 + 1);
      await page.locator('[data-testid="grid-expand"]').first().click();
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("coarse-pointer mobile landscape stays one full-width column above 768px", async () => {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await renderDenseGrid(context);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const cards = await gridMetrics(page);
      expect(cards).toHaveLength(2);
      expect(cards[0]!.width).toBe(844);
      expect(cards[0]!.height).toBe(844);
      expect(cards[1]!.top - cards[0]!.top).toBe(852);
      expect(cards[0]!.pageWidth).toBeLessThanOrEqual(cards[0]!.viewportWidth);
    } finally {
      await context.close();
    }
  }, 120_000);
});
