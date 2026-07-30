import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SHORTCUTS, type Shortcut } from "@thumbmux/core";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import ShortcutsSheet from "../src/ShortcutsSheet.svelte";

type ShortcutsSheetProps = {
  open?: boolean;
  shortcuts?: Shortcut[];
  onChange?: (next: Shortcut[]) => void;
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
};

const mounted: Mounted[] = [];

function mountShortcutsSheet(overrides: ShortcutsSheetProps = {}): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const props = {
    shortcuts: DEFAULT_SHORTCUTS,
    onChange: () => {},
    ...overrides,
  };

  let app!: Record<string, unknown>;
  try {
    flushSync(() => {
      app = mount(ShortcutsSheet, { target, props }) as Record<string, unknown>;
    });
  } catch (error) {
    target.remove();
    throw error;
  }

  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function shortcutRows(target: HTMLElement): HTMLElement[] {
  return Array.from(target.querySelectorAll<HTMLElement>('[data-testid="shortcut-row"]'));
}

function requiredElement<T extends Element>(target: ParentNode, selector: string): T {
  const element = target.querySelector<T>(selector);
  if (!element) throw new Error(`ShortcutsSheet did not render ${selector}`);
  return element;
}

afterEach(() => {
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

describe("ShortcutsSheet", () => {
  test("mounts as a real Svelte component without throwing", async () => {
    let result: Mounted | undefined;

    expect(() => {
      result = mountShortcutsSheet();
    }).not.toThrow();
    await tick();

    expect(result?.target.querySelectorAll('[data-testid="shortcuts-sheet"]')).toHaveLength(1);
  });

  test("renders every DEFAULT_SHORTCUTS entry as a row", async () => {
    const { target } = mountShortcutsSheet({ shortcuts: DEFAULT_SHORTCUTS });
    await tick();

    const rows = shortcutRows(target);
    expect(rows).toHaveLength(DEFAULT_SHORTCUTS.length);
    expect(rows.map((row) => requiredElement<HTMLInputElement>(row, "input.label").value)).toEqual(
      DEFAULT_SHORTCUTS.map((shortcut) => shortcut.label),
    );
    expect(rows.map((row) => requiredElement<HTMLInputElement>(row, "input.send").value)).toEqual(
      DEFAULT_SHORTCUTS.map((shortcut) => shortcut.send),
    );
  });

  test("adds one trimmed shortcut and emits the complete next list", async () => {
    const changes: Shortcut[][] = [];
    const { target } = mountShortcutsSheet({ onChange: (next) => changes.push(next) });

    const labelInput = requiredElement<HTMLInputElement>(
      target,
      '[data-testid="shortcut-new-label"]',
    );
    const sendInput = requiredElement<HTMLInputElement>(
      target,
      '[data-testid="shortcut-new-send"]',
    );
    const addButton = requiredElement<HTMLButtonElement>(
      target,
      '[data-testid="shortcut-add"]',
    );

    let submittedLabel = "";
    let submittedSend = "";
    flushSync(() => {
      labelInput.value = "  inspect queue  ";
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
      sendInput.value = "  run queue --verbose  ";
      sendInput.dispatchEvent(new Event("input", { bubbles: true }));
      submittedLabel = labelInput.value.trim();
      submittedSend = sendInput.value.trim();
      addButton.click();
    });
    await tick();

    expect(changes).toHaveLength(1);
    const next = changes[0]!;
    expect(next).toHaveLength(DEFAULT_SHORTCUTS.length + 1);
    expect(next.slice(0, DEFAULT_SHORTCUTS.length)).toEqual(DEFAULT_SHORTCUTS);

    const originalIds = new Set(DEFAULT_SHORTCUTS.map((shortcut) => shortcut.id));
    const added = next.find((shortcut) => !originalIds.has(shortcut.id));
    expect(added).toBeDefined();
    expect(added?.id).toMatch(/^sc-[0-9a-z]+$/);
    expect(added?.label).toBe(submittedLabel);
    expect(added?.send).toBe(submittedSend);
  });

  test("deletes only the selected shortcut and preserves every other entry", async () => {
    const changes: Shortcut[][] = [];
    const { target } = mountShortcutsSheet({ onChange: (next) => changes.push(next) });
    const rows = shortcutRows(target);
    const removedIndex = Math.floor(DEFAULT_SHORTCUTS.length / 2);
    const removed = DEFAULT_SHORTCUTS[removedIndex]!;
    const deleteButton = requiredElement<HTMLButtonElement>(rows[removedIndex]!, "button.del");

    flushSync(() => deleteButton.click());
    await tick();

    expect(changes).toHaveLength(1);
    const next = changes[0]!;
    expect(next).toHaveLength(DEFAULT_SHORTCUTS.length - 1);
    expect(next.some((shortcut) => shortcut.id === removed.id)).toBe(false);
    expect(next).toEqual(DEFAULT_SHORTCUTS.filter((shortcut) => shortcut.id !== removed.id));
  });

  for (const field of ["label", "send"] as const) {
    test(`edits ${field} without changing other fields or shortcuts`, async () => {
      const editedIndex = Math.floor(DEFAULT_SHORTCUTS.length / 2);
      const original = DEFAULT_SHORTCUTS[editedIndex]!;
      const changes: Shortcut[][] = [];
      const { target } = mountShortcutsSheet({ onChange: (next) => changes.push(next) });
      const row = shortcutRows(target)[editedIndex]!;
      const input = requiredElement<HTMLInputElement>(row, `input.${field}`);

      flushSync(() => {
        input.value = `${original[field]} — edited`;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await tick();

      expect(changes).toHaveLength(1);
      const next = changes[0]!;
      expect(next).toHaveLength(DEFAULT_SHORTCUTS.length);
      expect(next.filter((shortcut) => shortcut.id !== original.id)).toEqual(
        DEFAULT_SHORTCUTS.filter((shortcut) => shortcut.id !== original.id),
      );

      const edited = next.find((shortcut) => shortcut.id === original.id);
      expect(edited).toBeDefined();
      expect(edited?.[field]).toBe(input.value);
      const otherField = field === "label" ? "send" : "label";
      expect(edited?.[otherField]).toBe(original[otherField]);
      expect(edited?.id).toBe(original.id);
      expect(edited?.submit).toBe(original.submit);
      expect(edited?.agent).toBe(original.agent);
    });
  }
});
