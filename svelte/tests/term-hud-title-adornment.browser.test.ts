/**
 * Real-layout coverage for TermHud metadata and the dense SessionGrid. The
 * session name must never lose the row to the slot beside it, and dense cards
 * must honor pointer-aware geometry that happy-dom cannot calculate.
 *
 * The consumer report measured the failure precisely — with `status` pressed
 * into service as an inline badge at a 390px bar, `.nm` had clientWidth 15px
 * against scrollWidth 187px: the name clipped to its caret glyph. happy-dom
 * reports every width as 0, so the whole of that finding is invisible to the
 * suite that runs everywhere else. This file drives real Chromium by default
 * and can repeat the same source/layout checks in WebKit via
 * THUMBMUX_LAYOUT_BROWSER=webkit.
 *
 * The HUD suite carries its own control. Each width assertion is paired with the same
 * measurement taken while the collapse rule is neutralized by a stylesheet
 * override — if the harness were not really laying out, the control could not
 * reproduce the crush, and the test would fail rather than pass vacuously.
 * SessionThumb's transport alone is stubbed because wire/ANSI behavior has
 * dedicated tests; the real SessionGrid and SessionThumb markup/CSS own every
 * measured surface.
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
    build.onLoad({ filter: /ws-mux\.svelte\.ts$/ }, () => ({
      contents: `export const tmuxMux = { subscribe(_session, callback) {
        callback('\\u001b[30m0 \\u001b[31m1 \\u001b[32m2 \\u001b[33m3 \\u001b[34m4 \\u001b[35m5 \\u001b[36m6 \\u001b[37m7 \\u001b[90m8 \\u001b[91m9 \\u001b[92mA \\u001b[93mB \\u001b[94mC \\u001b[95mD \\u001b[96mE \\u001b[97mF \\u001b[38;5;242mI \\u001b[38;2;102;102;102mT \\u001b[38;2;102;102;102;48;2;102;102;102mB \\u001b[2;38;2;231;231;231mD \\u001b[0m\\nไทย กิ้ 👩🏽‍💻 ⣿ └─ dense preview', 'full');
        return () => {};
      } };`,
      loader: "js",
    }));
    build.onLoad({ filter: /\.svelte$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
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
import SessionGridHost from ${JSON.stringify(join(here, "./SessionGridHost.svelte"))};

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
  window.__denseKilled = [];
  const gridHost = mount(SessionGridHost, {
    target: document.getElementById("app"),
    props: {
      initialSessions: sessions,
      palette,
      onOpen(name) { window.__denseOpened.push(name); },
      onKill(name) { window.__denseKilled.push(name); },
      onNew() {},
      cardLayout: "dense",
      showNew: false,
    },
  });
  window.__replaceDenseSessions = (next) => gridHost.replaceSessions(next);
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

  const playwright = require("@playwright/test") as typeof import("@playwright/test");
  const requestedBrowser = process.env.THUMBMUX_LAYOUT_BROWSER ?? "chromium";
  if (requestedBrowser !== "chromium" && requestedBrowser !== "webkit") {
    throw new Error(`unsupported THUMBMUX_LAYOUT_BROWSER: ${requestedBrowser}`);
  }
  browser = await playwright[requestedBrowser].launch();
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
  noteLeft: number;
  noteRight: number;
  noteTop: number;
  noteWidth: number;
  noteTextWidth: number;
  noteClientHeight: number;
  noteScrollHeight: number;
  noteLineHeight: number;
  adornLineClamp: string;
  adornLeft: number;
  adornTop: number;
  adornWidth: number;
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
    const noteRange = document.createRange();
    noteRange.selectNodeContents(note);
    const titleStyle = getComputedStyle(title);
    const noteStyle = getComputedStyle(note);
    const adornStyle = getComputedStyle(adorn);
    const noteRect = note.getBoundingClientRect();
    const adornRect = adorn.getBoundingClientRect();
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
      noteLeft: noteRect.left,
      noteRight: noteRect.right,
      noteTop: noteRect.top,
      noteWidth: noteRect.width,
      noteTextWidth: noteRange.getBoundingClientRect().width,
      noteClientHeight: note.clientHeight,
      noteScrollHeight: note.scrollHeight,
      noteLineHeight: resolvedLineHeight(noteStyle),
      adornLineClamp: adornStyle.getPropertyValue("-webkit-line-clamp"),
      adornLeft: adornRect.left,
      adornTop: adornRect.top,
      adornWidth: adornRect.width,
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

function cssRgb(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`expected a computed rgb() color, received ${JSON.stringify(value)}`);
  }
  return channels as [number, number, number];
}

function relativeLuminance(value: string): number {
  const channels = cssRgb(value).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

type ContrastSample = { foreground: string; background: string; opacity: string };

function minimumContrast(samples: ContrastSample[]): number {
  return Math.min(...samples.map(({ foreground, background }) => contrastRatio(foreground, background)));
}

async function focusRingPixels(page: Page, png: Uint8Array): Promise<{
  innerWhite: number[];
  outerBlack: number[];
  surface: number[];
}> {
  const src = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return page.evaluate(async (imageSource) => {
    const loaded = new Image();
    loaded.src = imageSource;
    await loaded.decode();
    const canvas = document.createElement("canvas");
    canvas.width = loaded.naturalWidth;
    canvas.height = loaded.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(loaded, 0, 0);
    const y = Math.floor(canvas.height / 2);
    const sample = (x: number) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { innerWhite: sample(1), outerBlack: sample(4), surface: sample(8) };
  }, src);
}

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
    "sizes a short note to its content and gives the remaining wide row to activity",
    async () => {
      const page = await browser.newPage({ viewport: { width: 2200, height: 500 } });
      try {
        const measurement = await renderDense(page, {
          width: 2036,
          title: "codex-project-2",
          note: "test note",
          adorn: "งานยืด timeout ของ Claude Fable เป็น 2 ชั่วโมงทำจบแล้ว เทสต์ผ่าน ยังไม่ commit และตอนนี้รอคำสั่งใหม่",
        });
        expect(Math.abs(measurement.noteTop - measurement.adornTop)).toBeLessThanOrEqual(1);
        expect(measurement.noteWidth).toBeGreaterThan(1);
        expect(measurement.noteWidth).toBeLessThanOrEqual(measurement.noteTextWidth + 1);
        // Only the colon and the row's two 4px gaps belong between the fields.
        // The old equal-grow rule left roughly 780px of invisible note width.
        expect(measurement.adornLeft - measurement.noteRight).toBeLessThanOrEqual(24);
        expect(measurement.adornWidth).toBeGreaterThan(measurement.noteWidth * 5);
        expect(measurement.hudScrollWidth).toBeLessThanOrEqual(measurement.hudClientWidth + 1);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  test(
    "wraps all metadata without collapsing activity or overflowing the narrow bar",
    async () => {
      const page = await browser.newPage({ viewport: { width: 320, height: 500 } });
      try {
        const measurement = await renderDense(page, {
          width: 280,
          title: "codex-example-very-long-session-name-20260819",
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
        const head = card.querySelector<HTMLElement>('[data-testid="grid-dense-head"]')!;
        const sections = Array.from(head.querySelectorAll<HTMLElement>(':scope > .dense-section'));
        const copy = card.querySelector<HTMLElement>('[data-testid="grid-copy-name"]')!;
        const note = card.querySelector<HTMLElement>('[data-testid="grid-note"]')!;
        const summary = card.querySelector<HTMLElement>('[data-testid="grid-summary"]')!;
        const open = card.querySelector<HTMLElement>('[data-testid="grid-expand"]')!;
        const kill = card.querySelector<HTMLElement>('[data-testid="grid-kill"]')!;
        const thumb = card.querySelector<HTMLElement>('[data-testid="session-thumb"]')!;
        const tail = thumb.querySelector<HTMLElement>('.tail')!;
        const noteStyle = getComputedStyle(note);
        const summaryStyle = getComputedStyle(summary);
        const tailStyle = getComputedStyle(tail);
        const lineRects = Array.from(tail.querySelectorAll<HTMLElement>('.mtv-line')).map(
          (line) => line.getBoundingClientRect(),
        );
        const surfaceStyle = getComputedStyle(thumb);
        const renderedSamples = [
          { foreground: surfaceStyle.color, background: surfaceStyle.backgroundColor, opacity: surfaceStyle.opacity },
          ...Array.from(tail.querySelectorAll<HTMLElement>('[style*="color"]')).map((span) => {
            const style = getComputedStyle(span);
            return {
              foreground: style.color,
              background: style.backgroundColor === "rgba(0, 0, 0, 0)"
                ? surfaceStyle.backgroundColor
                : style.backgroundColor,
              opacity: style.opacity,
            };
          }),
        ];
        return {
          sectionCount: sections.length,
          sectionNames: sections.map((section) => section.dataset.section),
          sectionWidths: sections.map((section) => section.getBoundingClientRect().width),
          sectionDividerWidths: sections.slice(1).map((section) => getComputedStyle(section).borderLeftWidth),
          sectionDividerColors: sections.slice(1).map((section) => getComputedStyle(section).borderLeftColor),
          sectionColors: sections.map((section) => getComputedStyle(section).color),
          headHeight: head.getBoundingClientRect().height,
          headContainsOpen: head.contains(open),
          headText: head.textContent ?? "",
          openTag: open.tagName,
          openContainsThumb: open.contains(thumb),
          openSharesPreviewParent: open.parentElement === thumb.parentElement,
          openFollowsThumb: open.previousElementSibling === thumb,
          openPointerEvents: getComputedStyle(open).pointerEvents,
          killTag: kill.tagName,
          killText: kill.textContent,
          killWidth: kill.getBoundingClientRect().width,
          killHeight: kill.getBoundingClientRect().height,
          killTop: kill.getBoundingClientRect().top - head.getBoundingClientRect().top,
          killRight: head.getBoundingClientRect().right - kill.getBoundingClientRect().right,
          thumbBackground: surfaceStyle.backgroundColor,
          renderedSamples,
          thumbLineHeightRatio: Number.parseFloat(tailStyle.lineHeight) / Number.parseFloat(tailStyle.fontSize),
          thumbLinePitch: lineRects[1]!.top - lineRects[0]!.top,
          thumbLineHeight: Number.parseFloat(tailStyle.lineHeight),
          copyMinWidth: getComputedStyle(copy).minWidth,
          noteLineClamp: noteStyle.getPropertyValue("-webkit-line-clamp"),
          noteHeight: note.clientHeight,
          noteLineHeight: Number.parseFloat(noteStyle.lineHeight),
          summaryLineClamp: summaryStyle.getPropertyValue("-webkit-line-clamp"),
          summaryHeight: summary.clientHeight,
          summaryLineHeight: Number.parseFloat(summaryStyle.lineHeight),
        };
      });
      expect(denseChrome.sectionCount).toBe(3);
      expect(denseChrome.sectionNames).toEqual(["name", "note", "summary"]);
      expect(Math.max(...denseChrome.sectionWidths) - Math.min(...denseChrome.sectionWidths)).toBeLessThan(1);
      expect(denseChrome.sectionDividerWidths).toEqual(["1px", "1px"]);
      expect(denseChrome.sectionDividerColors).toEqual(["rgb(155, 149, 144)", "rgb(155, 149, 144)"]);
      expect(new Set(denseChrome.sectionColors).size).toBe(1);
      expect(denseChrome.headHeight).toBe(72);
      expect(denseChrome.headContainsOpen).toBe(false);
      expect(denseChrome.headText).not.toContain("↗");
      expect(denseChrome.openTag).toBe("BUTTON");
      expect(denseChrome.openContainsThumb).toBe(false);
      expect(denseChrome.openSharesPreviewParent).toBe(true);
      expect(denseChrome.openFollowsThumb).toBe(true);
      expect(denseChrome.openPointerEvents).toBe("auto");
      expect(denseChrome.killTag).toBe("BUTTON");
      expect(denseChrome.killText).toBe("×");
      expect(denseChrome.killWidth).toBe(44);
      expect(denseChrome.killHeight).toBe(44);
      expect(denseChrome.killTop).toBe(0);
      expect(denseChrome.killRight).toBe(0);
      expect(denseChrome.thumbBackground).toBe("rgb(102, 102, 102)");
      expect(denseChrome.renderedSamples.length).toBeGreaterThanOrEqual(21);
      expect(minimumContrast(denseChrome.renderedSamples)).toBeGreaterThanOrEqual(4.5);
      expect(denseChrome.renderedSamples.every((sample) => sample.opacity === "1")).toBe(true);
      expect(denseChrome.thumbLineHeightRatio).toBeCloseTo(1.1, 2);
      expect(denseChrome.thumbLinePitch).toBeCloseTo(denseChrome.thumbLineHeight, 1);
      expect(denseChrome.copyMinWidth).toBe("44px");
      expect(denseChrome.noteLineClamp).toBe("3");
      expect(denseChrome.noteHeight).toBeLessThanOrEqual(denseChrome.noteLineHeight * 3 + 1);
      expect(denseChrome.summaryLineClamp).toBe("3");
      expect(denseChrome.summaryHeight).toBeLessThanOrEqual(denseChrome.summaryLineHeight * 3 + 1);

      const firstCard = page.locator('[data-testid="grid-card"]').first();
      const openPreview = firstCard.locator('[data-testid="grid-expand"]');
      const thumbPreview = firstCard.locator('[data-testid="session-thumb"]');
      const originalOpenNode = await openPreview.elementHandle();
      expect(originalOpenNode).not.toBeNull();
      expect(await openPreview.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
      })).toBe(true);
      await openPreview.focus();
      await page.waitForTimeout(180);
      const focusedSurface = await openPreview.evaluate((element) => {
        const thumb = element.parentElement!.querySelector<HTMLElement>('[data-testid="session-thumb"]')!;
        const openStyle = getComputedStyle(element);
        const surfaceStyle = getComputedStyle(thumb);
        const focusStyle = getComputedStyle(element, "::after");
        return {
          background: surfaceStyle.backgroundColor,
          renderedSamples: [
            { foreground: surfaceStyle.color, background: surfaceStyle.backgroundColor, opacity: surfaceStyle.opacity },
            ...Array.from(thumb.querySelectorAll<HTMLElement>('[style*="color"]')).map((span) => {
              const style = getComputedStyle(span);
              return {
                foreground: style.color,
                background: style.backgroundColor === "rgba(0, 0, 0, 0)"
                  ? surfaceStyle.backgroundColor
                  : style.backgroundColor,
                opacity: style.opacity,
              };
            }),
          ],
          outlineColor: openStyle.outlineColor,
          outlineWidth: openStyle.outlineWidth,
          focusBoxShadow: focusStyle.boxShadow,
        };
      });
      expect(focusedSurface.background).toBe("rgb(17, 17, 17)");
      expect(focusedSurface.renderedSamples.some((sample) => sample.opacity === "0.6")).toBe(true);
      expect(focusedSurface.outlineWidth).toBe("0px");
      expect(focusedSurface.focusBoxShadow).toContain("rgb(255, 255, 255)");
      expect(focusedSurface.focusBoxShadow).toContain("rgb(17, 17, 17)");
      await thumbPreview.evaluate((thumb) => {
        (thumb as HTMLElement).style.setProperty("--tbg", "#f5f5f5");
      });
      const ring = await focusRingPixels(page, await openPreview.screenshot({ animations: "disabled" }));
      expect(ring.innerWhite.every((channel) => channel >= 250)).toBe(true);
      expect(ring.outerBlack.every((channel) => channel >= 14 && channel <= 20)).toBe(true);
      expect(ring.surface.every((channel) => channel >= 240)).toBe(true);
      await thumbPreview.evaluate((thumb) => {
        (thumb as HTMLElement).style.setProperty("--tbg", "#111111");
      });
      await openPreview.evaluate((element) => element.blur());
      await page.waitForTimeout(180);
      expect(await thumbPreview.evaluate(
        (thumb) => getComputedStyle(thumb).backgroundColor,
      )).toBe("rgb(102, 102, 102)");
      const hitBoxBeforeHover = await openPreview.boundingBox();
      await openPreview.hover();
      await page.waitForTimeout(180);
      expect(await thumbPreview.evaluate(
        (thumb) => getComputedStyle(thumb).backgroundColor,
      )).toBe("rgb(17, 17, 17)");
      const hitBoxAfterHover = await openPreview.boundingBox();
      expect(hitBoxBeforeHover).not.toBeNull();
      expect(hitBoxAfterHover).not.toBeNull();
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(hitBoxAfterHover![key] - hitBoxBeforeHover![key])).toBeLessThanOrEqual(1);
      }
      expect(await openPreview.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
      })).toBe(true);
      // Android WebView/XR pointers can emit HOVER_EXIT immediately before
      // the press. That resets the preview palette and rewrites the thumbnail
      // DOM; the stable sibling overlay must remain the hit target throughout.
      await openPreview.dispatchEvent("pointerleave", { pointerType: "mouse" });
      await page.waitForTimeout(180);
      expect(await thumbPreview.evaluate(
        (thumb) => getComputedStyle(thumb).backgroundColor,
      )).toBe("rgb(102, 102, 102)");
      expect(await openPreview.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
      })).toBe(true);
      expect(await originalOpenNode!.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.isConnected
          && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element;
      })).toBe(true);
      await page.mouse.down();
      await page.mouse.up();
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);
      await page.evaluate(() => {
        (window as unknown as { __denseOpened: string[] }).__denseOpened = [];
      });
      await openPreview.focus();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);
      await page.evaluate(() => {
        (window as unknown as { __denseOpened: string[] }).__denseOpened = [];
      });
      await openPreview.focus();
      await page.keyboard.press("Space");
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);
      await page.locator('[data-testid="grid-kill"]').first().click();
      expect(await page.evaluate(() => (
        window as unknown as { __denseKilled: string[] }
      ).__denseKilled)).toEqual(["codex-dense-alpha-very-long-name"]);
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);

      // If an embedded browser omits the compatibility click, pointerup owns
      // a short fallback and still activates exactly once.
      await page.evaluate(() => {
        (window as unknown as { __denseOpened: string[] }).__denseOpened = [];
        const block = (event: MouseEvent) => {
          if (!(event.target instanceof Element) || !event.target.closest('[data-testid="grid-expand"]')) return;
          document.removeEventListener("click", block, true);
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        document.addEventListener("click", block, true);
      });
      await openPreview.hover();
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(80);
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);

      // Live metadata can reorder keyed cards while the pointer is down. The
      // original session/node remains the activation target after it moves.
      await page.evaluate(() => {
        (window as unknown as { __denseOpened: string[] }).__denseOpened = [];
      });
      await openPreview.hover();
      await page.mouse.down();
      await page.evaluate(() => {
        (window as unknown as {
          __replaceDenseSessions: (sessions: Array<Record<string, string>>) => void;
        }).__replaceDenseSessions([
          { name: "grok-dense-beta", note: "รอ input", summary: "สรุปงานล่าสุดของ session" },
          { name: "codex-dense-alpha-very-long-name", note: "moved", summary: "still selected" },
        ]);
      });
      await page.waitForTimeout(30);
      expect(await originalOpenNode!.evaluate((element) => element.isConnected)).toBe(true);
      await page.mouse.up();
      await page.waitForTimeout(80);
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("forced-colors mode retains a painted keyboard focus indicator", async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      forcedColors: "active",
    });
    try {
      const page = await renderDenseGrid(context);
      const openPreview = page.locator('[data-testid="grid-expand"]').first();
      await page.keyboard.press("Tab");
      await openPreview.focus();
      const forcedFocus = await openPreview.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return { color: style.borderTopColor, style: style.borderTopStyle, width: style.borderTopWidth };
      });
      expect(forcedFocus.width).toBe("3px");
      expect(forcedFocus.style).toBe("solid");
      expect(forcedFocus.color).not.toBe("rgba(0, 0, 0, 0)");
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
      const openPreview = page.locator('[data-testid="grid-expand"]').first();
      const hit = await openPreview.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = Math.max(rect.top + 10, Math.min(rect.bottom - 10, window.innerHeight - 10));
        return {
          visiblePointIsButton: document.elementFromPoint(x, y) === element,
          x,
          y,
        };
      });
      expect(hit.visiblePointIsButton).toBe(true);
      await page.touchscreen.tap(hit.x, hit.y);
      expect(await page.evaluate(() => (
        window as unknown as { __denseOpened: string[] }
      ).__denseOpened)).toEqual(["codex-dense-alpha-very-long-name"]);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("phone portrait keeps three equal metadata sections and a full preview target", async () => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 700 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await renderDenseGrid(context);
      const card = page.locator('[data-testid="grid-card"]').first();
      const metrics = await card.evaluate((element) => {
        const head = element.querySelector<HTMLElement>('[data-testid="grid-dense-head"]')!;
        const sections = Array.from(head.querySelectorAll<HTMLElement>(':scope > .dense-section'));
        const open = element.querySelector<HTMLElement>('[data-testid="grid-expand"]')!;
        const thumb = element.querySelector<HTMLElement>('[data-testid="session-thumb"]')!;
        const cardRect = element.getBoundingClientRect();
        const openRect = open.getBoundingClientRect();
        return {
          cardWidth: cardRect.width,
          cardHeight: cardRect.height,
          headHeight: head.getBoundingClientRect().height,
          sectionWidths: sections.map((section) => section.getBoundingClientRect().width),
          openWidth: openRect.width,
          openHeight: openRect.height,
          thumbBackground: getComputedStyle(thumb).backgroundColor,
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(metrics.cardWidth).toBe(320);
      expect(metrics.cardHeight).toBe(320);
      expect(metrics.headHeight).toBe(72);
      expect(Math.max(...metrics.sectionWidths) - Math.min(...metrics.sectionWidths)).toBeLessThan(1);
      expect(metrics.openWidth).toBe(metrics.cardWidth - 2);
      expect(metrics.openHeight).toBe(metrics.cardHeight - metrics.headHeight - 2);
      expect(metrics.thumbBackground).toBe("rgb(102, 102, 102)");
      expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    } finally {
      await context.close();
    }
  }, 120_000);
});
