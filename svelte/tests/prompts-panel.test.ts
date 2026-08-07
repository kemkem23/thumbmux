import { afterEach, describe, expect, test } from "bun:test";
import { extractRecentPrompts, stripAnsi } from "@thumbmux/core";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import PromptsPanel from "../src/PromptsPanel.svelte";

type PromptsPanelProps = {
  prompts?: string[];
  loading?: boolean;
  onPick: (prompt: string) => void;
  labels?: { title: string; loading: string; none: string };
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
};

const mounted: Mounted[] = [];

function mountPromptsPanel(overrides: Partial<PromptsPanelProps> = {}): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const props: PromptsPanelProps = {
    onPick: () => {},
    ...overrides,
  };

  let app!: Record<string, unknown>;
  try {
    flushSync(() => {
      app = mount(PromptsPanel, { target, props }) as Record<string, unknown>;
    });
  } catch (error) {
    target.remove();
    throw error;
  }

  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function recentPromptsFromPane(): string[] {
  return extractRecentPrompts([
    "\x1b[1m\u203a\x1b[0m inspect the websocket reconnect path",
    "\u2022 response one",
    "\u276f add coverage for the touch controls",
    "\u273b response two",
    "\u203a verify the third callback payload",
    "\u25cf response three",
    "\u276f explain the release boundary",
    "\u2022 response four",
    "\u203a summarize the final diff",
    "\u25cf response five",
  ], { targetCount: 5 });
}

function promptAuthorStyle(prompt: HTMLButtonElement): CSSStyleDeclaration {
  const scopeClass = Array.from(prompt.classList).find((name) => name.startsWith("svelte-"));
  if (!scopeClass) throw new Error("mounted prompt has no Svelte scope class");

  const expectedSelector = `.prompt.${scopeClass}`;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[];
    try {
      rules = Array.from(sheet.cssRules);
    } catch {
      continue;
    }

    for (const rule of rules) {
      const styleRule = rule as CSSStyleRule;
      const selectors = styleRule.selectorText?.split(",").map((selector) => selector.trim());
      if (selectors?.includes(expectedSelector) && styleRule.style) return styleRule.style;
    }
  }

  throw new Error(`mounted stylesheet has no ${expectedSelector} rule`);
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

describe("PromptsPanel", () => {
  test("mounts as a real Svelte component", async () => {
    let result: Mounted | undefined;

    expect(() => {
      result = mountPromptsPanel();
    }).not.toThrow();
    await tick();

    expect(result?.target.querySelectorAll('[data-testid="prompts-panel"]')).toHaveLength(1);
  });

  test("renders every extracted prompt in recency order", async () => {
    const prompts = recentPromptsFromPane();
    expect(prompts).toHaveLength(5);

    const { target } = mountPromptsPanel({ prompts });
    await tick();

    const rows = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-testid="prompt-item"]'),
    );
    expect(rows).toHaveLength(prompts.length);
    expect(rows.map((row) => row.textContent ?? "")).toEqual(prompts);
  });

  test("passes the DOM-selected third prompt to onPick exactly once", async () => {
    const picked: string[] = [];
    const { target } = mountPromptsPanel({
      prompts: recentPromptsFromPane(),
      onPick: (prompt) => picked.push(prompt),
    });
    await tick();

    const rows = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-testid="prompt-item"]'),
    );
    const selected = rows[2];
    if (!selected) throw new Error("PromptsPanel did not render a third prompt");
    const selectedTextFromDom = selected.textContent ?? "";

    flushSync(() => selected.click());
    await tick();

    expect(picked).toEqual([selectedTextFromDom]);
  });

  test("renders the empty state without a ghost prompt row", async () => {
    let result: Mounted | undefined;

    expect(() => {
      result = mountPromptsPanel({ prompts: [] });
    }).not.toThrow();
    await tick();

    expect(result?.target.querySelectorAll('[data-testid="prompts-panel"]')).toHaveLength(1);
    expect(result?.target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(0);
    expect(result?.target.querySelector(".pnone")?.textContent).toBe("no prompts found yet");
  });

  test("preserves long, ANSI-derived, and Thai prompt text under the two-line layout clamp", async () => {
    const longThaiPrompt = "\u0e17\u0e14\u0e2a\u0e2d\u0e1a".repeat(110);
    const extractedPrompts = extractRecentPrompts([
      "\x1b[1m\u203a\x1b[0m \x1b[36mANSI-coloured prompt\x1b[0m",
      "\u2022 response one",
      `\u276f ${longThaiPrompt}`,
      "\u273b response two",
      "\u203a \u0e0a\u0e48\u0e27\u0e22\u0e15\u0e23\u0e27\u0e08\u0e01\u0e32\u0e23\u0e41\u0e2a\u0e14\u0e07\u0e1c\u0e25\u0e20\u0e32\u0e29\u0e32\u0e44\u0e17\u0e22\u0e43\u0e19\u0e41\u0e1c\u0e07\u0e19\u0e35\u0e49",
      "\u25cf response three",
    ], { targetCount: 3 });
    expect(extractedPrompts).toHaveLength(3);

    const rawAnsiPrompt = `\x1b[38;5;45m${extractedPrompts[0]}\x1b[0m`;
    const prompts = [...extractedPrompts, rawAnsiPrompt];

    const { target } = mountPromptsPanel({ prompts });
    await tick();

    const rows = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-testid="prompt-item"]'),
    );
    const rendered = rows.map((row) => row.textContent ?? "");
    const ansiRows = rows.filter((row) => row.textContent?.includes("\x1b"));
    const nonAnsiRendered = rendered.filter((text) => !text.includes("\x1b"));

    expect(rows).toHaveLength(prompts.length);
    expect(nonAnsiRendered).toEqual(extractedPrompts);
    expect(rows.every((row) => row.childElementCount === 0)).toBe(true);
    expect(ansiRows).toHaveLength(1);
    const ansiTextFromDom = ansiRows[0]?.textContent ?? "";
    expect(ansiTextFromDom.match(/\x1b/g) ?? []).toHaveLength(2);
    expect(stripAnsi(ansiTextFromDom)).toBe(extractedPrompts[0]);
    expect(rendered.some((text) => /\p{Script=Thai}/u.test(text))).toBe(true);

    const producerTruncatedPrompt = rendered.find((text) => text.endsWith("..."));
    expect(producerTruncatedPrompt?.length).toBe(500);

    const authorStyle = promptAuthorStyle(rows[0]!);
    expect(authorStyle.getPropertyValue("min-height").trim()).toBe("44px");
    expect(authorStyle.getPropertyValue("-webkit-line-clamp").trim()).toBe("2");
    expect(authorStyle.getPropertyValue("-webkit-box-orient").trim()).toBe("vertical");
    expect(authorStyle.getPropertyValue("overflow").trim()).toBe("hidden");
  });
});

describe("collapsible disclosure", () => {
  test("without the prop the list is always open and the title is not a control", async () => {
    const { target } = mountPromptsPanel({ prompts: ["one", "two"] });
    await tick();

    expect(target.querySelector('[data-testid="prompts-toggle"]')).toBeNull();
    expect(target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(2);
    // The title stays a plain div — a host that never opts in gets the same
    // DOM it had before this prop existed.
    const title = target.querySelector(".ptitle");
    expect(title?.tagName).toBe("DIV");
  });

  test("collapsible starts closed, hides the list, and reports its state", async () => {
    const { target } = mountPromptsPanel({ prompts: ["one", "two"], collapsible: true });
    await tick();

    const toggle = target.querySelector<HTMLButtonElement>('[data-testid="prompts-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(0);
    // The count is visible while collapsed — otherwise the disclosure gives no
    // reason to open it.
    expect(toggle!.textContent).toContain("(2)");
  });

  test("clicking the disclosure opens and closes the list", async () => {
    const { target } = mountPromptsPanel({ prompts: ["one", "two"], collapsible: true });
    await tick();

    const toggle = target.querySelector<HTMLButtonElement>('[data-testid="prompts-toggle"]')!;
    toggle.click();
    flushSync();
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(2);

    toggle.click();
    flushSync();
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(0);
  });

  test("initiallyOpen starts expanded, and is ignored without collapsible", async () => {
    const open = mountPromptsPanel({ prompts: ["one"], collapsible: true, initiallyOpen: true });
    await tick();
    expect(
      open.target.querySelector('[data-testid="prompts-toggle"]')!.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(open.target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(1);

    const notCollapsible = mountPromptsPanel({ prompts: ["one"], initiallyOpen: false });
    await tick();
    // initiallyOpen:false must not close a panel that was never collapsible.
    expect(notCollapsible.target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(1);
  });

  test("the empty and loading states are hidden while collapsed too", async () => {
    const { target } = mountPromptsPanel({ prompts: [], collapsible: true, loading: true });
    await tick();
    expect(target.querySelector(".pnone")).toBeNull();

    const toggle = target.querySelector<HTMLButtonElement>('[data-testid="prompts-toggle"]')!;
    // Nothing to count, so no count — an empty "(0)" is noise.
    expect(toggle.textContent).not.toContain("(0)");
    toggle.click();
    flushSync();
    await tick();
    expect(target.querySelector(".pnone")).not.toBeNull();
  });
});
