<script lang="ts">
  import { createRawSnippet } from "svelte";
  import TermHud from "../src/TermHud.svelte";
  import PromptsPanel from "../src/PromptsPanel.svelte";

  let {
    prompts = [],
    note = "รอรีวิวผลรอบสุดท้าย",
    summary = "กำลังไล่แก้เลย์เอาต์ recall ของ thumbmux ให้แสดง prompt เต็มและไม่กินพื้นที่เทอร์มินัลเกินจำเป็น",
    cwd = "/home/kemkem23/kemcortex/cortex-orchestrator",
    title = "codex-kem-cortex-orchestrator-1",
  }: {
    prompts?: string[];
    note?: string;
    summary?: string;
    cwd?: string;
    title?: string;
  } = $props();

  let picked = $state("");
  let expanded = $state(true);
  let barHeight = $state(0);
  let summaryOpen = $state(true);

  const titleAdornment = createRawSnippet(() => ({
    render: () => `<span data-testid="session-summary-adornment" lang="th">${summary}</span>`,
  }));
</script>

{#snippet hudPanel()}
  <div class="hud-panel-stack">
    <PromptsPanel
      {prompts}
      collapsible={true}
      initiallyOpen={true}
      onPick={(prompt) => { picked = prompt; }}
      labels={{
        title: "PROMPTS ล่าสุด — แตะเพื่อแก้/ส่งซ้ำ",
        loading: "กำลังอ่านจากจอ…",
        none: "ยังไม่พบ prompt ในจอช่วงล่าสุด",
      }}
    />
    <div class="hud-meta-column" data-testid="hud-meta-column">
    <div class="session-recap-panel" data-testid="session-recap-panel">
      <div class="session-summary-panel" data-testid="session-summary-panel">
        <button
          class="summary-title"
          onclick={() => (summaryOpen = !summaryOpen)}
          aria-expanded={summaryOpen}
          data-testid="session-summary-toggle"
          lang="th"
        >
          <span aria-hidden="true">{summaryOpen ? "▾" : "▸"}</span>
          <span>กำลังทำอะไรอยู่</span>
        </button>
        {#if summaryOpen}
          <p class="summary-body" data-testid="session-summary-text" lang="th">{summary}</p>
        {/if}
      </div>
      <div class="session-cwd-panel" data-testid="session-cwd-panel">
        <span>CWD</span>
        <code>{cwd}</code>
      </div>
    </div>
    <div class="notep note-standin" data-testid="note-panel">
      <div class="text" data-testid="note-text">{note || "ยังไม่มี note สำหรับ session นี้"}</div>
      <div class="ops">
        <button type="button" data-testid="note-edit">✎ แก้ไข</button>
      </div>
    </div>
    </div>
  </div>
{/snippet}

<div class="stage" data-testid="session-view" data-picked={picked}>
  <div class="mtv-host" style:top={`${barHeight}px`} data-testid="mtv">
    <pre class="fake-term">ready
❯ latest submitted prompt
● working on recall layout
$ </pre>
  </div>
  <TermHud
    chip="CODEX"
    {title}
    {note}
    status="working"
    working={true}
    layout="dense"
    bind:barHeight
    bind:expanded
    onBack={() => {}}
    titleAdornment={titleAdornment}
    notePrefix=""
    statusCase="none"
    panel={hudPanel}
  />
  <textarea data-testid="composer-prefill" value={picked}></textarea>
</div>

<style>
  .stage {
    --agent: #7dffa0;
    --tbg: #101014;
    --tstage: #0a0a0d;
    --tfg: #e6e6e6;
    --hud: rgba(16, 16, 20, .95);
    --hud-fg: #e6e6e6;
    --hud-line: #34343a;
    --font-mono: ui-monospace, "DejaVu Sans Mono", monospace;
    --font-thai: "Noto Sans Thai", "Sarabun", ui-sans-serif, sans-serif;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: clip;
    background: var(--tstage);
    color: var(--hud-fg);
    font-family: var(--font-mono);
  }
  .mtv-host {
    position: absolute; left: 0; right: 0; bottom: 0;
    background: var(--tbg); color: #9c9; overflow: hidden;
  }
  .fake-term { margin: 8px; font: 12px var(--font-mono); }
  textarea { position: absolute; left: -9999px; width: 1px; height: 1px; }
</style>
