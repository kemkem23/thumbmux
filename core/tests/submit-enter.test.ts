import { describe, expect, test } from "bun:test";

import { submitPlan, type SubmitAgent } from "../src/submit";
import * as core from "../src/index";

function namedAgent(left: string, right: string): SubmitAgent {
  return `${left}${right}` as SubmitAgent;
}

// Built from fragments on purpose: repo-wide greps for the removed v0.4.0
// "structured bundle" submit path must not match this regression test.
const REMOVED_OPTION_KEY = ["native", "Bundle"].join("");
const REMOVED_AGENT = ["native", "codex"].join("-");

describe("submitPlan always delivers Enter", () => {
  test("every agent plan ends with a bare carriage return", () => {
    const agents = [
      undefined,
      "generic",
      namedAgent("clau", "de"),
      namedAgent("gr", "ok"),
      namedAgent("co", "dex"),
    ] as const;

    for (const agent of agents) {
      const plan = submitPlan("hello", agent ? { agent } : {});
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.at(-1)!.keys).toBe("\r");
      expect(plan.some((s) => s.keys === "\r")).toBe(true);
    }
  });

  test("the extra-enter agent keeps text, Enter, and the delayed second Enter", () => {
    expect(submitPlan("hello", { agent: namedAgent("co", "dex") })).toEqual([
      { keys: "hello", delayBeforeMs: 0 },
      { keys: "\r", delayBeforeMs: 150 },
      { keys: "\r", delayBeforeMs: 1000 },
    ]);
  });

  test("no option can suppress the Enter", () => {
    const rogue: Record<string, unknown> = {
      agent: REMOVED_AGENT,
      [REMOVED_OPTION_KEY]: {
        audience: "CODER",
        subject: "s",
        row_count: 1,
        decoded_byte_count: 1,
        rows_hex: "0a",
      },
    };
    const plan = submitPlan("hello", rogue as never);
    // An unknown option must never be able to turn a submit into a no-Enter
    // delivery — that is exactly how the prompt ended up typed-but-never-submitted.
    expect(plan.at(-1)!.keys).toBe("\r");
  });

  test("no step is ever a structured control envelope", () => {
    const rogue: Record<string, unknown> = {
      agent: REMOVED_AGENT,
      [REMOVED_OPTION_KEY]: {
        audience: "CODER",
        subject: "s",
        row_count: 1,
        decoded_byte_count: 1,
        rows_hex: "0a",
      },
    };
    const roguePlan = submitPlan("hello", rogue as never);
    const codexPlan = submitPlan("hello", { agent: namedAgent("co", "dex") });

    // keys are raw terminal bytes, never a JSON control message — tmux types them literally.
    for (const plan of [roguePlan, codexPlan]) {
      for (const step of plan) {
        expect(step.keys.includes("PROMPT_BUNDLE")).toBe(false);
        expect(step.keys.trimStart().startsWith("{")).toBe(false);
      }
    }
  });

  test("the core barrel exposes no structured-prompt helpers", () => {
    // The removed helpers produced payloads no receiver ever read.
    const names = [
      ["native", "Codex", "Submit"].join(""),
      ["text", "To", "Native", "Bundle"].join(""),
      ["decode", "Bundle", "Prompt", "Text"].join(""),
      ["build", "Native", "Codex", "Prompt"].join(""),
      ["is", "Native", "Codex", "Prompt"].join(""),
      ["QUOTA", "_", "REQUEST", "_", "COUNT"].join(""),
    ];
    const barrel = core as Record<string, unknown>;
    for (const name of names) {
      expect(name in barrel).toBe(false);
    }
  });
});
