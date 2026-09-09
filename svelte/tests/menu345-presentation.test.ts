/**
 * W3-I2 — presentation pieces the host still writes by hand.
 *
 * A24 `SessionMetadata`: the CWD row and the last-activity row.
 * B03 `ThemeSourceChoice`: the two-state "session colours / agent colours"
 * picker and its selected state.
 *
 * Both are presentation only. Every assertion below reads the DOM the
 * component actually produced, not a value the test typed in a moment
 * earlier, and every fixture string is synthetic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "./svelte-client";

import SessionMetadata from "../src/SessionMetadata.svelte";
import ThemeSourceChoice from "../src/ThemeSourceChoice.svelte";

type Mounted = { app: Record<string, unknown>; target: HTMLElement };

const mounted: Mounted[] = [];

function mountComponent(
  component: unknown,
  props: Record<string, unknown>,
): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  let app!: Record<string, unknown>;
  try {
    flushSync(() => {
      app = mount(component as Parameters<typeof mount>[0], {
        target,
        props,
      }) as Record<string, unknown>;
    });
  } catch (error) {
    target.remove();
    throw error;
  }

  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function query<T extends Element>(target: ParentNode, selector: string): T | null {
  return target.querySelector<T>(selector);
}

function required<T extends Element>(target: ParentNode, selector: string): T {
  const found = target.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function byTestId<T extends Element>(target: ParentNode, id: string): T | null {
  return query<T>(target, `[data-testid="${id}"]`);
}

/** Visible text with markup indentation collapsed — what a reader sees. */
function text(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  // Whatever a test mounts, it unmounts — a leaked component keeps its
  // effects alive across the rest of the file.
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

const CWD = "/srv/synthetic-lane/w3i2/workspace";

describe("SessionMetadata (A24)", () => {
  test("renders the cwd row with the full path and a title tooltip", () => {
    const { target } = mountComponent(SessionMetadata, { cwd: CWD });

    const row = byTestId<HTMLElement>(target, "session-cwd-panel");
    expect(row).not.toBeNull();

    const code = required<HTMLElement>(target, "code");
    expect(code.textContent).toBe(CWD);
    // The path is clipped by CSS, never shortened in the DOM: a host that
    // copies from this node must get the whole string back.
    expect(code.getAttribute("title")).toBe(CWD);
  });

  test("a very long path is still complete in the DOM", () => {
    const long = `/srv/${"segment/".repeat(40)}end`;
    const { target } = mountComponent(SessionMetadata, { cwd: long });

    const code = required<HTMLElement>(target, "code");
    expect(code.textContent).toBe(long);
    expect(code.textContent?.includes("…")).toBe(false);
    expect(code.getAttribute("title")).toBe(long);
  });

  test("omits the cwd row when no cwd is given", () => {
    const { target } = mountComponent(SessionMetadata, {
      activityLabel: "3 นาทีที่แล้ว",
    });

    expect(byTestId(target, "session-cwd-panel")).toBeNull();
    expect(query(target, "code")).toBeNull();
    expect(byTestId(target, "session-activity")).not.toBeNull();
  });

  test("treats an empty or whitespace-only cwd as absent", () => {
    for (const blank of ["", "   ", "\t\n "]) {
      const { target } = mountComponent(SessionMetadata, {
        cwd: blank,
        activityLabel: "เมื่อครู่",
      });
      expect(byTestId(target, "session-cwd-panel")).toBeNull();
      expect(query(target, "code")).toBeNull();
    }
  });

  test("renders nothing at all when both facts are missing", () => {
    const { target } = mountComponent(SessionMetadata, {});

    expect(byTestId(target, "session-metadata")).toBeNull();
    expect(target.textContent?.trim()).toBe("");
  });

  test("renders nothing when both facts are blank strings", () => {
    const { target } = mountComponent(SessionMetadata, {
      cwd: "  ",
      activityLabel: "\n",
    });

    expect(byTestId(target, "session-metadata")).toBeNull();
  });

  test("uses <time datetime> only when a machine timestamp is supplied", () => {
    const withStamp = mountComponent(SessionMetadata, {
      activityLabel: "3 นาทีที่แล้ว",
      activityDatetime: "2026-09-10T04:05:06.000Z",
    });
    const time = required<HTMLElement>(withStamp.target, "time");
    expect(time.getAttribute("datetime")).toBe("2026-09-10T04:05:06.000Z");
    expect(time.textContent).toBe("3 นาทีที่แล้ว");

    const withoutStamp = mountComponent(SessionMetadata, {
      activityLabel: "3 นาทีที่แล้ว",
    });
    expect(query(withoutStamp.target, "time")).toBeNull();
    const row = required<HTMLElement>(
      withoutStamp.target,
      '[data-testid="session-activity"]',
    );
    expect(text(row)).toBe("3 นาทีที่แล้ว");
  });

  test("captions come from props — the package ships no wording of its own", () => {
    const { target } = mountComponent(SessionMetadata, {
      cwd: CWD,
      cwdLabel: "ที่อยู่",
      activityLabel: "เมื่อครู่",
      activityLabelText: "ขยับล่าสุด",
    });

    const cwdRow = required<HTMLElement>(
      target,
      '[data-testid="session-cwd-panel"]',
    );
    expect(text(cwdRow)).toBe(`ที่อยู่ ${CWD}`);

    const activityRow = required<HTMLElement>(
      target,
      '[data-testid="session-activity"]',
    );
    expect(text(activityRow)).toBe("ขยับล่าสุด เมื่อครู่");
  });

  test("the host keeps its own selectors through props", () => {
    const { target } = mountComponent(SessionMetadata, {
      cwd: CWD,
      activityLabel: "เมื่อครู่",
      testid: "session-recap-meta",
      cwdTestid: "host-cwd",
      activityTestid: "host-activity",
      extraClass: "host-layout",
    });

    expect(byTestId(target, "session-recap-meta")).not.toBeNull();
    expect(byTestId(target, "host-cwd")).not.toBeNull();
    expect(byTestId(target, "host-activity")).not.toBeNull();
    // the package defaults must be gone, not merely joined by the overrides
    expect(byTestId(target, "session-cwd-panel")).toBeNull();
    expect(byTestId(target, "session-metadata")).toBeNull();

    const root = required<HTMLElement>(target, '[data-testid="session-recap-meta"]');
    expect(root.classList.contains("host-layout")).toBe(true);
  });
});

describe("ThemeSourceChoice (B03)", () => {
  const LABELS = { offLabel: "สีเดิมของ session", onLabel: "ทำสีตาม agent" };

  test("renders exactly two choices with the host's labels", () => {
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      onChange: () => {},
    });

    const buttons = Array.from(target.querySelectorAll("button"));
    expect(buttons.length).toBe(2);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "สีเดิมของ session",
      "ทำสีตาม agent",
    ]);
  });

  test("selected state follows `enabled` on both sides", () => {
    const off = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: false,
      onChange: () => {},
    });
    const offLeft = required<HTMLButtonElement>(
      off.target,
      '[data-testid="agent-theme-off"]',
    );
    const offRight = required<HTMLButtonElement>(
      off.target,
      '[data-testid="agent-theme-on"]',
    );
    expect(offLeft.getAttribute("aria-pressed")).toBe("true");
    expect(offRight.getAttribute("aria-pressed")).toBe("false");
    expect(offLeft.classList.contains("on")).toBe(true);
    expect(offRight.classList.contains("on")).toBe(false);

    // Re-mounting with the opposite value proves the mark is derived from the
    // prop, not from anything the component kept from its first render.
    const on = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: true,
      onChange: () => {},
    });
    const onLeft = required<HTMLButtonElement>(
      on.target,
      '[data-testid="agent-theme-off"]',
    );
    const onRight = required<HTMLButtonElement>(
      on.target,
      '[data-testid="agent-theme-on"]',
    );
    expect(onLeft.getAttribute("aria-pressed")).toBe("false");
    expect(onRight.getAttribute("aria-pressed")).toBe("true");
    expect(onLeft.classList.contains("on")).toBe(false);
    expect(onRight.classList.contains("on")).toBe(true);
  });

  test("choosing the other side reports the new value once", () => {
    const calls: boolean[] = [];
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: false,
      onChange: (next: boolean) => calls.push(next),
    });

    const onButton = required<HTMLButtonElement>(
      target,
      '[data-testid="agent-theme-on"]',
    );
    flushSync(() => onButton.click());

    expect(calls).toEqual([true]);
  });

  test("choosing the other side from the on state reports false", () => {
    const calls: boolean[] = [];
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: true,
      onChange: (next: boolean) => calls.push(next),
    });

    const offButton = required<HTMLButtonElement>(
      target,
      '[data-testid="agent-theme-off"]',
    );
    flushSync(() => offButton.click());

    expect(calls).toEqual([false]);
  });

  test("pressing the already-selected side reports nothing", () => {
    const calls: boolean[] = [];
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: false,
      onChange: (next: boolean) => calls.push(next),
    });

    const offButton = required<HTMLButtonElement>(
      target,
      '[data-testid="agent-theme-off"]',
    );
    flushSync(() => offButton.click());
    flushSync(() => offButton.click());

    expect(calls).toEqual([]);
  });

  test("the host owns the value — a click does not move the selection", () => {
    const calls: boolean[] = [];
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: false,
      onChange: (next: boolean) => calls.push(next),
    });

    const onButton = required<HTMLButtonElement>(
      target,
      '[data-testid="agent-theme-on"]',
    );
    flushSync(() => onButton.click());

    // The host in this test never wrote the value back, so the mark must stay
    // where it was; a component that flipped itself would drift from the host.
    expect(calls).toEqual([true]);
    expect(onButton.getAttribute("aria-pressed")).toBe("false");
    expect(
      required<HTMLButtonElement>(
        target,
        '[data-testid="agent-theme-off"]',
      ).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("disabled blocks both sides and reports nothing", () => {
    const calls: boolean[] = [];
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: false,
      disabled: true,
      onChange: (next: boolean) => calls.push(next),
    });

    const buttons = Array.from(target.querySelectorAll("button"));
    expect(buttons.every((b) => b.disabled)).toBe(true);
    for (const button of buttons) flushSync(() => button.click());
    expect(calls).toEqual([]);
  });

  test("the hint is the host's text and disappears when absent", () => {
    const withHint = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: true,
      hint: "ทำสีตาม agent — พื้นและสีตามผู้ให้บริการ",
      onChange: () => {},
    });
    const hint = required<HTMLElement>(
      withHint.target,
      '[data-testid="theme-source-hint"]',
    );
    expect(hint.textContent).toBe("ทำสีตาม agent — พื้นและสีตามผู้ให้บริการ");

    const withoutHint = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: true,
      onChange: () => {},
    });
    expect(byTestId(withoutHint.target, "theme-source-hint")).toBeNull();
  });

  test("the host keeps its own selectors through props", () => {
    const { target } = mountComponent(ThemeSourceChoice, {
      ...LABELS,
      enabled: false,
      onChange: () => {},
      testid: "host-theme-choice",
      offTestid: "host-theme-off",
      onTestid: "host-theme-on",
      lang: "th",
    });

    expect(byTestId(target, "host-theme-choice")).not.toBeNull();
    expect(byTestId(target, "host-theme-off")).not.toBeNull();
    expect(byTestId(target, "host-theme-on")).not.toBeNull();
    expect(byTestId(target, "agent-theme-off")).toBeNull();
    expect(byTestId(target, "agent-theme-on")).toBeNull();

    const buttons = Array.from(target.querySelectorAll("button"));
    expect(buttons.every((b) => b.getAttribute("lang") === "th")).toBe(true);
  });
});

describe("neither component reaches into host state", () => {
  test("mounting and clicking writes nothing to localStorage", () => {
    localStorage.clear();
    const before = localStorage.length;

    mountComponent(SessionMetadata, { cwd: CWD, activityLabel: "เมื่อครู่" });

    const choice = mountComponent(ThemeSourceChoice, {
      offLabel: "a",
      onLabel: "b",
      enabled: false,
      onChange: () => {},
    });
    flushSync(() =>
      required<HTMLButtonElement>(
        choice.target,
        '[data-testid="agent-theme-on"]',
      ).click(),
    );

    // The host's `kx-*` keys stay the host's business — the package must not
    // have learned any of them.
    expect(localStorage.length).toBe(before);
  });
});
