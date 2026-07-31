import { describe, expect, test } from "bun:test";
import { exactTmuxPaneTarget, exactTmuxTarget } from "../src";

const unusualNames = [
  "dash-name",
  "dot.name",
  "7-leading",
  "prefix",
  "prefix-child",
] as const;

describe("exact tmux target helpers", () => {
  test("return the exact session and pane forms", () => {
    expect(exactTmuxTarget("s")).toBe("=s");
    expect(exactTmuxPaneTarget("s")).toBe("=s:");
  });

  test("pane targets start with the exact-match marker", () => {
    const targets = unusualNames.map(exactTmuxPaneTarget);
    expect(targets.every((target) => target.startsWith("="))).toBe(true);
  });

  test("pane targets end with the pane selector", () => {
    const targets = unusualNames.map(exactTmuxPaneTarget);
    expect(targets.every((target) => target.endsWith(":"))).toBe(true);
  });

  test("unusual names preserve the relation to exact session targets", () => {
    const sessionTargets = unusualNames.map(exactTmuxTarget);
    const paneTargets = unusualNames.map(exactTmuxPaneTarget);

    expect(paneTargets).toEqual(sessionTargets.map((target) => `${target}:`));
  });
});
