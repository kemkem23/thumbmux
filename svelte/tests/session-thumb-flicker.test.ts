import { afterEach, describe, expect, test } from "bun:test";
import type { AnsiPalette } from "@thumbmux/core";
import { createSgrState, lineToHtml } from "@thumbmux/core";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import SessionThumb from "../src/SessionThumb.svelte";
import { deriveThumbnailPalette, type GridSession } from "../src/session-grid";
import { tmuxMux } from "../src/ws-mux.svelte";
import SessionGridHost from "./SessionGridHost.svelte";

const palette: AnsiPalette = {
  defaultFg: "#eeeeee",
  defaultBg: "#111111",
  base: [
    "#000000", "#aa0000", "#00aa00", "#aa5500",
    "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
    "#555555", "#ff5555", "#55ff55", "#ffff55",
    "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
  ],
};

const originalSubscribe = tmuxMux.subscribe.bind(tmuxMux);
let mounted: Record<string, unknown> | null = null;
let target: HTMLDivElement | null = null;
let deliver: ((data: string, type?: string) => void) | null = null;

afterEach(() => {
  tmuxMux.subscribe = originalSubscribe as typeof tmuxMux.subscribe;
  deliver = null;
  if (mounted) unmount(mounted);
  target?.remove();
  mounted = null;
  target = null;
});

async function mountThumb(maxLines = 4): Promise<HTMLDivElement> {
  tmuxMux.subscribe = ((_session, callback) => {
    deliver = callback;
    return () => {
      deliver = null;
    };
  }) as typeof tmuxMux.subscribe;

  target = document.createElement("div");
  document.body.appendChild(target);
  flushSync(() => {
    mounted = mount(SessionThumb, {
      target: target!,
      props: { session: "flicker-fixture", palette, maxLines },
    }) as Record<string, unknown>;
  });
  await tick();
  if (!deliver) throw new Error("SessionThumb did not subscribe");
  return target;
}

async function sendFrame(raw: string): Promise<void> {
  if (!deliver) throw new Error("SessionThumb delivery callback missing");
  flushSync(() => deliver!(raw, "output"));
  await tick();
}

function legacyTailHtml(raw: string, linesToKeep: number): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const start = Math.max(0, lines.length - linesToKeep);
  const st = createSgrState();
  const thumbPalette = deriveThumbnailPalette(palette);
  for (let i = 0; i < start; i++) {
    lineToHtml(lines[i]!, st, thumbPalette);
  }
  return lines
    .slice(start)
    .map((line) => `<div class="mtv-line">${lineToHtml(line, st, thumbPalette) || "&nbsp;"}</div>`)
    .join("");
}

describe("SessionThumb incremental line rendering", () => {
  test("a one-line frame change preserves the existing line DOM", async () => {
    const host = await mountThumb(3);
    await sendFrame("\x1b[31mstable-left\nspinner-1\nstable-right\x1b[0m");

    const before = [...host.querySelectorAll<HTMLDivElement>(".tail > .mtv-line")];
    const beforeSpans = before.map((line) => line.querySelector("span"));
    expect(before).toHaveLength(3);
    expect(beforeSpans.every(Boolean)).toBe(true);

    await sendFrame("\x1b[31mstable-left\nspinner-2\nstable-right\x1b[0m");

    const after = [...host.querySelectorAll<HTMLDivElement>(".tail > .mtv-line")];
    expect(after).toHaveLength(3);
    expect(after[1]?.textContent).toBe("spinner-2");
    // The keyed rows stay mounted. With the old container-level {@html}, a
    // one-byte change assigns tail.innerHTML and all three references change.
    expect(after[0] === before[0]).toBe(true);
    expect(after[1] === before[1]).toBe(true);
    expect(after[2] === before[2]).toBe(true);
    // Per-line {@html} also takes Svelte's equal-string fast path: unchanged
    // line contents are untouched while the changed row alone is replaced.
    expect(after[0]!.querySelector("span") === beforeSpans[0]).toBe(true);
    expect(after[1]!.querySelector("span") === beforeSpans[1]).toBe(false);
    expect(after[2]!.querySelector("span") === beforeSpans[2]).toBe(true);
  });

  test("line markup stays byte-identical to the legacy joined renderer", async () => {
    const maxLines = 4;
    const raw = [
      "\x1b[32mdiscarded context",
      "green <tag> & text",
      "",
      "ไทย 漢字",
      "reset\x1b[0m",
    ].join("\r\n");
    const host = await mountThumb(maxLines);
    await sendFrame(raw);

    const tail = host.querySelector<HTMLElement>(".tail");
    if (!tail) throw new Error("SessionThumb tail missing");
    // Parse the legacy blob once before comparing serialization. lineToHtml
    // emits a literal U+00A0 for an empty row, which innerHTML spells &nbsp;.
    const legacy = document.createElement("div");
    legacy.innerHTML = legacyTailHtml(raw, maxLines);
    expect(tail.innerHTML).toBe(legacy.innerHTML);
  });
});

describe("SessionThumb subscription stability", () => {
  test("fresh grid metadata with the same session name keeps the live subscription and tail", async () => {
    const subscriptions: Array<{
      session: string;
      tail?: number;
      deliver: (data: string, type?: string) => void;
    }> = [];
    let unsubscribeCount = 0;

    tmuxMux.subscribe = ((session, callback, options) => {
      subscriptions.push({ session, tail: options?.tail, deliver: callback });
      return () => {
        unsubscribeCount += 1;
      };
    }) as typeof tmuxMux.subscribe;

    target = document.createElement("div");
    document.body.appendChild(target);
    flushSync(() => {
      mounted = mount(SessionGridHost, {
        target: target!,
        props: {
          initialSessions: [
            { name: "steady-session", state: "idle", subtitle: "first snapshot" },
          ] satisfies GridSession[],
          palette,
        },
      }) as Record<string, unknown>;
    });
    await tick();

    const host = mounted as {
      replaceSessions?: (sessions: GridSession[]) => void;
    };
    if (typeof host.replaceSessions !== "function") {
      throw new Error("SessionGridHost did not export replaceSessions");
    }

    expect(subscriptions.map(({ session, tail }) => ({ session, tail }))).toEqual([
      { session: "steady-session", tail: 40 },
    ]);
    flushSync(() => {
      subscriptions[0]!.deliver("stable left\nstable right", "output");
    });
    await tick();

    const thumbBefore = target.querySelector<HTMLElement>('[data-testid="session-thumb"]');
    const tailBefore = thumbBefore?.querySelector<HTMLElement>(".tail");
    if (!thumbBefore || !tailBefore) throw new Error("SessionGrid thumbnail did not become live");
    expect(thumbBefore.querySelector(".wait")).toBeNull();

    flushSync(() => {
      host.replaceSessions!([
        {
          name: "steady-session",
          state: "working",
          subtitle: "second snapshot",
          lastActivityAt: 1_765_732_800_000,
        },
      ]);
    });
    await tick();

    // Control: the fresh metadata object reached the retained keyed card.
    expect(target.querySelector('[data-testid="grid-subtitle"]')?.textContent).toBe("second snapshot");
    expect(target.querySelector('[data-testid="grid-state"]')?.getAttribute("data-state")).toBe("working");
    // But an equal primitive (session, maxLines) pair must not tear down the
    // wire subscription, clear connected, or replace the live tail.
    expect(subscriptions).toHaveLength(1);
    expect(unsubscribeCount).toBe(0);
    const thumbAfter = target.querySelector<HTMLElement>('[data-testid="session-thumb"]');
    expect(thumbAfter === thumbBefore).toBe(true);
    expect(thumbAfter?.querySelector(".wait")).toBeNull();
    expect(thumbAfter?.querySelector(".tail") === tailBefore).toBe(true);
  });
});
