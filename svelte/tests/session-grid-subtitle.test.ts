import { afterEach, describe, expect, test } from "bun:test";
import type { AnsiPalette } from "@thumbmux/core";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import SessionGrid from "../src/SessionGrid.svelte";
import type { GridSession } from "../src/session-grid";

const palette: AnsiPalette = {
  base: [
    "#111111", "#333333", "#444444", "#555555", "#666666", "#777777", "#888888", "#999999",
    "#aaaaaa", "#bbbbbb", "#cccccc", "#dddddd", "#eeeeee", "#f0f0f0", "#fafafa", "#ffffff",
  ],
  defaultFg: "#777777",
  defaultBg: "#666666",
};

const mounted: Array<{ app: Record<string, unknown>; target: HTMLElement }> = [];

function mountGrid(sessions: GridSession[], extra: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(SessionGrid, {
      target,
      props: { sessions, palette, onOpen: () => {}, onNew: () => {}, ...extra },
    }) as Record<string, unknown>;
  });
  mounted.push({ app, target });
  return target;
}

afterEach(() => {
  while (mounted.length) {
    const entry = mounted.pop()!;
    flushSync(() => { void unmount(entry.app); });
    entry.target.remove();
  }
});

describe("grid card subtitle", () => {
  test("a card without a subtitle renders no subtitle node", async () => {
    const target = mountGrid([{ name: "alpha-1", state: "idle" }]);
    await tick();
    expect(target.querySelectorAll('[data-testid="grid-card"]').length).toBeGreaterThan(0);
    expect(target.querySelector('[data-testid="grid-subtitle"]')).toBeNull();
  });

  test("a subtitle renders as text under the name", async () => {
    const target = mountGrid([
      { name: "alpha-1", state: "working", subtitle: "กำลังรันเทสต์ชุดใหญ่อยู่" },
    ]);
    await tick();
    const subtitle = target.querySelector('[data-testid="grid-subtitle"]');
    expect(subtitle).not.toBeNull();
    expect(subtitle!.textContent).toBe("กำลังรันเทสต์ชุดใหญ่อยู่");
    // Text, not markup: a host summary is untrusted model output.
    expect(subtitle!.childElementCount).toBe(0);
  });

  test("markup in a subtitle stays text", async () => {
    const target = mountGrid([
      { name: "alpha-1", subtitle: "<img src=x onerror=alert(1)> done" },
    ]);
    await tick();
    const subtitle = target.querySelector('[data-testid="grid-subtitle"]')!;
    expect(subtitle.childElementCount).toBe(0);
    expect(subtitle.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(target.querySelector("img")).toBeNull();
  });

  test("the subtitle survives grouping (both card branches render it)", async () => {
    const target = mountGrid(
      [
        { name: "alpha-1", groupKey: "build", groupLabel: "Build", subtitle: "หนึ่ง" },
        { name: "beta-1", groupKey: "review", groupLabel: "Review", subtitle: "สอง" },
      ],
      { groupable: true, defaultGrouped: true },
    );
    await tick();
    const texts = Array.from(target.querySelectorAll('[data-testid="grid-subtitle"]')).map(
      (node) => node.textContent,
    );
    expect(texts.sort()).toEqual(["สอง", "หนึ่ง"]);
  });

  test("a long subtitle is clamped rather than growing the card", async () => {
    const target = mountGrid([{ name: "alpha-1", subtitle: "ก".repeat(400) }]);
    await tick();
    const style = getComputedStyle(target.querySelector('[data-testid="grid-subtitle"]')!);
    expect(style.getPropertyValue("-webkit-line-clamp").trim()).toBe("2");
    expect(style.getPropertyValue("overflow").trim()).toBe("hidden");
  });
});

describe("dense grid card metadata", () => {
  test("keeps default cards unchanged when dense fields are supplied but not enabled", async () => {
    const target = mountGrid([{ name: "alpha-1", note: "operator note", summary: "live summary" }]);
    await tick();
    expect(target.querySelector('[data-testid="grid-card"]')?.tagName).toBe("BUTTON");
    expect(target.querySelector('[data-testid="grid-dense-head"]')).toBeNull();
    expect(target.querySelector('[data-testid="grid-note"]')).toBeNull();
    expect(target.querySelector('[data-testid="grid-summary"]')).toBeNull();
  });

  test("renders balanced dense sections, copies the name, opens from the preview, and can hide new", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let copied = "";
    const opened: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text; } },
    });
    try {
      const target = mountGrid(
        [{
          name: "alpha-dense-1",
          note: "โน้ต <b>ต้องเป็น text</b>",
          summary: "กำลังรัน integration tests",
        }],
        {
          cardLayout: "dense",
          showNew: false,
          onOpen: (name: string) => opened.push(name),
        },
      );
      await tick();

      const card = target.querySelector<HTMLElement>('[data-testid="grid-card"]')!;
      const head = card.querySelector<HTMLElement>('[data-testid="grid-dense-head"]')!;
      expect(card.tagName).toBe("DIV");
      expect(Array.from(head.querySelectorAll<HTMLElement>(':scope > .dense-section')).map(
        (section) => section.dataset.section,
      )).toEqual(["name", "note", "summary"]);
      expect(head.querySelector('[data-testid="grid-expand"]')).toBeNull();
      expect(head.textContent).not.toContain("↗");
      expect(head.querySelector('.dense-separator')).toBeNull();
      expect(card.querySelector('[data-testid="grid-note"]')!.textContent).toBe(
        "โน้ต <b>ต้องเป็น text</b>",
      );
      expect(card.querySelector('[data-testid="grid-note"]')!.childElementCount).toBe(0);
      expect(card.querySelector('[data-testid="grid-summary"]')!.textContent).toBe(
        "กำลังรัน integration tests",
      );
      expect(card.querySelector('[data-testid="session-thumb"]')!.classList.contains("dense")).toBe(true);
      expect(target.querySelector('[data-testid="grid-new"]')).toBeNull();

      const copy = card.querySelector<HTMLButtonElement>('[data-testid="grid-copy-name"]')!;
      const openPreview = card.querySelector<HTMLButtonElement>('[data-testid="grid-expand"]')!;
      const note = card.querySelector<HTMLElement>('[data-testid="grid-note"]')!;
      const summary = card.querySelector<HTMLElement>('[data-testid="grid-summary"]')!;
      expect(getComputedStyle(copy).minWidth).toBe("44px");
      expect(openPreview.tagName).toBe("BUTTON");
      expect(openPreview.classList.contains("dense-open")).toBe(true);
      expect(openPreview.querySelector('[data-testid="session-thumb"]')).not.toBeNull();
      expect(getComputedStyle(note).getPropertyValue("-webkit-line-clamp").trim()).toBe("3");
      expect(getComputedStyle(summary).getPropertyValue("-webkit-line-clamp").trim()).toBe("3");

      flushSync(() => {
        copy.click();
      });
      await Promise.resolve();
      expect(copied).toBe("alpha-dense-1");
      expect(opened).toEqual([]);

      flushSync(() => {
        openPreview.click();
      });
      expect(opened).toEqual(["alpha-dense-1"]);
      expect(copied).toBe("alpha-dense-1");
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test("renders dense metadata through the grouped branch and accepts subtitle as summary fallback", async () => {
    const target = mountGrid(
      [{
        name: "alpha-grouped",
        groupKey: "build",
        groupLabel: "Build",
        note: "pinned",
        subtitle: "legacy summary",
      }],
      { cardLayout: "dense", groupable: true, defaultGrouped: true },
    );
    await tick();
    expect(target.querySelector('[data-testid="grid-note"]')?.textContent).toBe("pinned");
    expect(target.querySelector('[data-testid="grid-summary"]')?.textContent).toBe("legacy summary");
  });
});
