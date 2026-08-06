/**
 * FS4 — DesktopKeys: layout-independent shortcut chords + in-pane focusables
 * must not mute the terminal.
 *
 * RED-before-GREEN: these cases fail on the pre-fix DesktopKeys.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import DesktopKeys from "../src/DesktopKeys.svelte";

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
const mounted: Mounted[] = [];

function track(app: Record<string, unknown>, target: HTMLElement): Mounted {
  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function mountDesktopKeys(props: Record<string, unknown>): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(DesktopKeys as never, { target, props }) as Record<string, unknown>;
  });
  return track(app, target);
}

afterEach(() => {
  const sel = window.getSelection?.();
  sel?.removeAllRanges();
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
});

function desktopRoot(target: HTMLElement): HTMLElement {
  const root = target.querySelector<HTMLElement>(".desktop-keys");
  if (!root) throw new Error("DesktopKeys root missing");
  return root;
}

function dispatchKey(
  el: EventTarget,
  init: KeyboardEventInit & { key: string; code?: string },
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  flushSync(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

function selectTextInside(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  if (!sel) throw new Error("window.getSelection missing");
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("FS4 DesktopKeys physical-key shortcut identity", () => {
  test("Thai Kedmanee Ctrl+C with selection yields to browser (does not send \\x03)", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    const span = document.createElement("span");
    span.textContent = "copy-me";
    root.appendChild(span);
    selectTextInside(span);

    // Thai Kedmanee: physical KeyC produces key 'แ', not 'c'.
    dispatchKey(root, {
      key: "แ",
      code: "KeyC",
      ctrlKey: true,
    });

    expect(sent).toEqual([]);
  });

  test("Thai Kedmanee Ctrl+V yields to browser paste pipeline (does not send \\x16)", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    // Thai Kedmanee: physical KeyV produces key 'อ', not 'v'.
    dispatchKey(root, {
      key: "อ",
      code: "KeyV",
      ctrlKey: true,
    });

    expect(sent).toEqual([]);
  });

  test("Thai Kedmanee Ctrl+C without selection still sends SIGINT \\x03", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    dispatchKey(root, {
      key: "แ",
      code: "KeyC",
      ctrlKey: true,
    });

    expect(sent).toEqual(["\x03"]);
  });

  test("Latin Ctrl+C with selection still yields (regression)", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    const span = document.createElement("span");
    span.textContent = "copy-me";
    root.appendChild(span);
    selectTextInside(span);

    dispatchKey(root, { key: "c", code: "KeyC", ctrlKey: true });
    expect(sent).toEqual([]);
  });
});

describe("FS4 DesktopKeys in-pane focusable must not mute typing", () => {
  test("focus on OSC-8 <a> inside the pane still routes printable keys", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    // Control: root-focused typing works.
    dispatchKey(root, { key: "x", code: "KeyX" });
    expect(sent).toEqual(["x"]);
    sent.length = 0;

    // Simulate click-focus landing on a terminal URL (real <a> from ansi-html).
    const link = document.createElement("a");
    link.href = "https://example.com/path";
    link.textContent = "https://example.com/path";
    link.tabIndex = 0;
    root.appendChild(link);
    flushSync(() => link.focus());
    await tick();

    expect(document.activeElement).toBe(link);

    // Keydown targets the anchor (bubbles to DesktopKeys root). Must not mute.
    dispatchKey(link, { key: "a", code: "KeyA" });
    expect(sent).toEqual(["a"]);
  });

  test("real textarea inside the wrapper still owns its keystrokes", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    const ta = document.createElement("textarea");
    root.appendChild(ta);
    flushSync(() => ta.focus());
    await tick();

    dispatchKey(ta, { key: "z", code: "KeyZ" });
    expect(sent).toEqual([]);
  });

  test("button inside the terminal root does not block printable keys", async () => {
    const sent: string[] = [];
    const { target } = mountDesktopKeys({
      enabled: true,
      focused: true,
      onKeys: (data: string) => sent.push(data),
    });
    await tick();
    const root = desktopRoot(target);
    flushSync(() => root.focus());
    await tick();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "x";
    root.appendChild(btn);
    flushSync(() => btn.focus());
    await tick();

    dispatchKey(btn, { key: "b", code: "KeyB" });
    expect(sent).toEqual(["b"]);
  });
});
