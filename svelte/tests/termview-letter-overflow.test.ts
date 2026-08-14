/**
 * Letter boxes must not clip leftward script ink (Thai ำ, Devanagari, …).
 *
 * `.mtv-w1` / `.mtv-w2` / `.mtv-wx` reserve a measured cell. Thai SARA AM
 * (U+0E33) is a letter in its own one-cell box whose นิคหิต is designed to
 * sit over the previous consonant — ink bounds start at x0 ≈ −0.42em.
 * `overflow: hidden` on the letter box deletes that mark entirely:
 * "ทำให้" paints as "ทาให้".
 *
 * Production change that would make this fail: putting `overflow: hidden`
 * back on the shared pin rule, or dropping it from `.mtv-w1.mtv-fit`
 * (square-ink symbols still need the clip as a backstop).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const termView = readFileSync(join(here, "../src/TermView.svelte"), "utf8");
const sessionThumb = readFileSync(join(here, "../src/SessionThumb.svelte"), "utf8");

type Rule = { selector: string; body: string };

function styleBlock(src: string, label: string): string {
  const match = src.match(/<style>([\s\S]*?)<\/style>/);
  if (!match) throw new Error(`${label} has no <style> block`);
  return match[1] ?? "";
}

function cssRules(css: string): Rule[] {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned))) {
    rules.push({
      selector: (match[1] ?? "").replace(/\s+/g, " ").trim(),
      body: match[2] ?? "",
    });
  }
  return rules;
}

function sharedPinRule(src: string, label: string): Rule {
  const hit = cssRules(styleBlock(src, label)).find((rule) =>
    rule.selector.includes(".mtv-w1") &&
    rule.selector.includes(".mtv-w2") &&
    rule.selector.includes(".mtv-wx")
  );
  if (!hit) throw new Error(`${label}: shared .mtv-w1/.mtv-w2/.mtv-wx pin rule missing`);
  return hit;
}

function fitRule(src: string, label: string): Rule {
  const hit = cssRules(styleBlock(src, label)).find((rule) =>
    /mtv-w1\.mtv-fit/.test(rule.selector)
  );
  if (!hit) throw new Error(`${label}: .mtv-w1.mtv-fit rule missing`);
  return hit;
}

describe("letter-box overflow is a clip of last resort, not the default", () => {
  for (const [label, src] of [
    ["TermView", termView],
    ["SessionThumb", sessionThumb],
  ] as const) {
    test(`${label}: .mtv-w1/.mtv-w2/.mtv-wx do not clip; .mtv-fit still does`, () => {
      const shared = sharedPinRule(src, label);
      expect(
        shared.body,
        `${label} shared pin rule must not set overflow:hidden — Thai ำ / Devanagari marks reach left of their own origin`,
      ).not.toMatch(/overflow\s*:\s*hidden/);

      const fit = fitRule(src, label);
      expect(
        fit.body,
        `${label} .mtv-w1.mtv-fit must keep overflow:hidden — square symbol ink is scaled on purpose and the clip is the backstop`,
      ).toMatch(/overflow\s*:\s*hidden/);
    });
  }
});
