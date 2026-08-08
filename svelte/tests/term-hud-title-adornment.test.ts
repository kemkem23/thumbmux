/**
 * TM-04 — an inline slot on the session-name row, plus the two undocumented
 * transforms that made `status` and `note` unusable for any other wording.
 *
 * Consumer report (v0.11.1 adoption report, TM-04): a host with live per-session
 * information had no published way to put it beside the session name. All three
 * substitutes were measured and fail — `chip` is the single agent-identity badge,
 * `note` lands on a second line force-prefixed with ✎, and `status` is
 * force-uppercased and `flex: 0 0 auto`, so at 390px it took 248px and clipped
 * the name to its caret glyph (`.nm` clientWidth 15px against scrollWidth 187px).
 *
 * These are the structural assertions. The width guarantee itself needs a real
 * layout engine and lives in `term-hud-title-adornment.browser.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Component } from "svelte";
import { createRawSnippet, flushSync, mount, tick, unmount } from "./svelte-client";

import TermHud from "../src/TermHud.svelte";

const mounted: Array<{ app: Record<string, unknown>; target: HTMLElement }> = [];

afterEach(() => {
  while (mounted.length) {
    const entry = mounted.pop()!;
    flushSync(() => {
      void unmount(entry.app);
    });
    entry.target.remove();
  }
});

function mountHud(props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermHud as Component, {
      target,
      props: { chip: "CC", title: "term-3fsy9c-orchestrator", onBack: () => {}, ...props },
    }) as Record<string, unknown>;
  });
  mounted.push({ app, target });
  return target;
}

/** Svelte's scope class is a hash of the component's whole stylesheet, so it
 * moves for any CSS edit anywhere in the file. Consumers never target it — they
 * target `.nm`, `.hud-caret`, `.hud-note`. Normalizing it keeps the identity
 * assertion about the thing that can actually break them: elements, attributes
 * and text. */
function withoutScopeClass(html: string): string {
  return html.replace(/\s*svelte-[a-z0-9]+/g, "").replace(/ class=""/g, "");
}

/** Rendering the name row through an `{#if}` costs two inert comment anchors —
 * every Svelte conditional emits them, they are not elements, and no selector,
 * `:nth-child` or `children[]` index can see them. They are the entire
 * difference; strip them and what is left has to match exactly. */
function elementsOnly(html: string): string {
  return withoutScopeClass(html).replace(/<!---->/g, "").replace(/\s+/g, " ").trim();
}

/** A host snippet: plain text, mixed case, at whatever the row's font is. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span class="host-chip">${text}</span>`,
  }));
}

describe("TM-04 · titleAdornment", () => {
  test("omitting the prop leaves the name row byte-identical to a build without it", async () => {
    const target = mountHud();
    await tick();
    const names = target.querySelector(".hud-names")!;
    // The markup v0.13.1 shipped. A consumer's CSS and e2e selectors are written
    // against this; the slot is additive or it is a break.
    expect(elementsOnly(names.innerHTML)).toBe(
      '<span class="nm">term-3fsy9c-orchestrator <span class="hud-caret">▾</span></span>',
    );
    const nm = target.querySelector(".nm")!;
    // None of the slotted layout may reach a row that did not ask for it.
    expect(nm.className.replace(/\s*svelte-[a-z0-9]+/g, "")).toBe("nm");
    expect(target.querySelector(".nm-title")).toBeNull();
    expect(target.querySelector('[data-testid="hud-title-adornment"]')).toBeNull();
  });

  test("a snippet renders on the name row, after the name and before the caret", async () => {
    const target = mountHud({ titleAdornment: textSnippet("2m14s") });
    await tick();
    const nm = target.querySelector(".nm")!;
    expect(nm.classList.contains("nm-slotted")).toBe(true);

    const order = Array.from(nm.children).map((el) => el.className.split(" ")[0]);
    expect(order).toEqual(["nm-title", "nm-slot", "hud-caret"]);

    expect(nm.querySelector(".nm-title")!.textContent).toBe("term-3fsy9c-orchestrator");
    expect(nm.querySelector('[data-testid="hud-title-adornment"]')!.textContent).toBe("2m14s");
  });

  test("slot content is never case-transformed", async () => {
    const target = mountHud({ titleAdornment: textSnippet("Build 4 · queued") });
    await tick();
    expect(
      target.querySelector('[data-testid="hud-title-adornment"]')!.textContent,
    ).toBe("Build 4 · queued");
  });

  test("with no layout engine to measure with, the slot renders rather than being swallowed", async () => {
    // happy-dom reports every width as 0. "Unknown" must not read as "collapse":
    // a host that server-renders, or tests in a DOM without layout, would
    // otherwise lose the content with nothing to explain where it went.
    const target = mountHud({ titleAdornment: textSnippet("2m14s") });
    await tick();
    const slot = target.querySelector('[data-testid="hud-title-adornment"]')!;
    expect(slot.getAttribute("data-collapsed")).toBe("false");
    expect(slot.classList.contains("nm-slot-collapsed")).toBe(false);
  });
});

describe("TM-04 · status and note transforms are opt-in", () => {
  test("status still uppercases by default", async () => {
    const target = mountHud({ status: "working" });
    await tick();
    expect(target.querySelector(".st")!.textContent!.trim()).toBe("WORKING");
  });

  test("statusCase='none' renders the status exactly as given", async () => {
    const target = mountHud({ status: "รอ input", statusCase: "none" });
    await tick();
    expect(target.querySelector(".st")!.textContent!.trim()).toBe("รอ input");
  });

  test("the empty-status placeholder is unchanged in both modes", async () => {
    const upper = mountHud({});
    await tick();
    expect(upper.querySelector(".st")!.textContent!.trim()).toBe("…");
    const none = mountHud({ statusCase: "none" });
    await tick();
    expect(none.querySelector(".st")!.textContent!.trim()).toBe("…");
  });

  test("note still carries the ✎ prefix by default", async () => {
    const target = mountHud({ note: "รอ merge" });
    await tick();
    expect(target.querySelector(".hud-note")!.textContent).toBe("✎ รอ merge");
  });

  test("notePrefix='' renders the note verbatim, and a custom prefix replaces ✎", async () => {
    const bare = mountHud({ note: "รอ merge", notePrefix: "" });
    await tick();
    expect(bare.querySelector(".hud-note")!.textContent).toBe("รอ merge");

    const custom = mountHud({ note: "รอ merge", notePrefix: "› " });
    await tick();
    expect(custom.querySelector(".hud-note")!.textContent).toBe("› รอ merge");
  });
});
