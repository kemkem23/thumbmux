import { describe, expect, test } from "bun:test";
import { DEFAULT_LAUNCH_PRESETS, buildLaunchCommand, buildLaunchSpec } from "../src/launch";

const byId = (id: string) => {
  const p = DEFAULT_LAUNCH_PRESETS.find((p) => p.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return p;
};

describe("default presets", () => {
  test("the stock seven exist: 3 agents × plain/worktree + blank", () => {
    expect(DEFAULT_LAUNCH_PRESETS.map((p) => p.id)).toEqual([
      "claude", "claude-worktree", "codex", "codex-worktree", "grok", "grok-worktree", "blank",
    ]);
    expect(DEFAULT_LAUNCH_PRESETS.filter((p) => p.worktree).length).toBe(3);
  });

  test("every agent preset's DEFAULT permission injects its bypass flag", () => {
    expect(buildLaunchCommand(byId("claude"))).toBe("claude --dangerously-skip-permissions");
    expect(buildLaunchCommand(byId("claude-worktree"))).toBe("claude --dangerously-skip-permissions");
    expect(buildLaunchCommand(byId("codex"))).toBe("codex --dangerously-bypass-approvals-and-sandbox");
    expect(buildLaunchCommand(byId("codex-worktree"))).toBe("codex --dangerously-bypass-approvals-and-sandbox");
    expect(buildLaunchCommand(byId("grok"))).toBe("grok --permission-mode bypassPermissions");
    expect(buildLaunchCommand(byId("grok-worktree"))).toBe("grok --permission-mode bypassPermissions");
  });

  test("blank preset injects nothing", () => {
    expect(buildLaunchCommand(byId("blank"))).toBe("");
    const spec = buildLaunchSpec(byId("blank"));
    expect(spec.command).toBe("");
    expect(spec.agent).toBe("");
  });
});

describe("dropdown combinations inject the right flags", () => {
  test("claude: every permission × every model", () => {
    const p = byId("claude");
    for (const perm of p.permissionOptions) {
      for (const model of p.modelOptions) {
        const cmd = buildLaunchCommand(p, perm.value, model.value);
        expect(cmd.startsWith("claude")).toBe(true);
        if (perm.flag) expect(cmd).toContain(perm.flag);
        else expect(cmd).not.toContain("--dangerously");
        if (model.flag) expect(cmd).toContain(model.flag);
      }
    }
    expect(buildLaunchCommand(p, "plan", "opus")).toBe("claude --permission-mode plan --model opus");
    expect(buildLaunchCommand(p, "ask", "haiku")).toBe("claude --model haiku");
    expect(buildLaunchCommand(p, "accept-edits", "default")).toBe("claude --permission-mode acceptEdits");
  });

  test("codex: sandbox modes and models", () => {
    const p = byId("codex");
    expect(buildLaunchCommand(p, "auto", "gpt-5.5")).toBe("codex --full-auto -m gpt-5.5");
    expect(buildLaunchCommand(p, "ask", "gpt-5.4-mini")).toBe("codex -m gpt-5.4-mini");
    expect(buildLaunchCommand(p, "bypass", "default")).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  test("grok: permission and models", () => {
    const p = byId("grok");
    expect(buildLaunchCommand(p, "bypass", "grok-build")).toBe("grok --permission-mode bypassPermissions --model grok-build");
    expect(buildLaunchCommand(p, "ask", "grok-composer-2.5-fast")).toBe("grok --model grok-composer-2.5-fast");
  });

  test("unknown dropdown values fall back to the first (default) option", () => {
    const p = byId("claude");
    expect(buildLaunchCommand(p, "nope", "nope")).toBe("claude --dangerously-skip-permissions");
  });

  test("spec carries agent/worktree hints for the host", () => {
    const spec = buildLaunchSpec(byId("codex-worktree"), "bypass", "gpt-5.5");
    expect(spec).toEqual({
      presetId: "codex-worktree",
      agent: "codex",
      worktree: true,
      permission: "bypass",
      model: "gpt-5.5",
      command: "codex --dangerously-bypass-approvals-and-sandbox -m gpt-5.5",
    });
  });
});
