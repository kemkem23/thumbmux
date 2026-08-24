/** Package-local content and host-layout fixtures for the real-browser HUD tests. */

function pad(length: number, seed: string): string {
  let text = "";
  while (text.length < length) text += seed;
  return text.slice(0, length);
}

function syntheticPrompt(prefix: string, length: number, seed: string): string {
  return `${prefix}${pad(length, seed)}`.slice(0, length);
}

export const SYNTHETIC_CODEX_PROMPTS = [
  syntheticPrompt(
    'อัปโหลดไฟล์ "example-layout.png" เสร็จแล้ว → uploads/example-layout.png This synthetic mixed-language prompt verifies immediate recall, natural wrapping, exact text, and measured panel height. ',
    485,
    'layout spacing ภาษาไทย English selection accessibility ',
  ),
  syntheticPrompt(
    "ถ้าผู้อ่านเลื่อนออกจากล่างสุด ให้ข้อความที่กำลังอัปเดตอยู่นิ่งและไม่ดึงตำแหน่งอ่านกลับไปท้ายจอ ",
    165,
    "scroll anchor live update ",
  ),
  syntheticPrompt(
    "จัด header เป็น <session> : <note> : <activity> : <expand> แบบหนาแน่น รองรับข้อความหลายบรรทัด การคัดลอกชื่อ และเป้าสัมผัสที่เข้าถึงได้ ",
    542,
    "thumbnail responsive desktop mobile dense layout ภาษาไทย English ",
  ),
] as const;

const FIVE_LONG = [
  pad(500, "ก้ำไทยล้วน"),
  pad(500, "EnglishOnlyBlock"),
  pad(500, "ผสมไทยEnglish"),
  `/home/dev/${pad(500 - "/home/dev/".length, "x")}`,
  pad(500, "กeปิดmixed"),
];

export const FIXTURES: ReadonlyArray<{ id: string; prompts: readonly string[] }> = [
  { id: "none", prompts: [] },
  { id: "one-short", prompts: ["ตรวจ regression ล่าสุด"] },
  {
    id: "three-mixed",
    prompts: [
      pad(40, "สั้นมากและพอดีหนึ่งแถวxx"),
      `กลาง ${pad(110, "recall ")}จบ`,
      `ยาว ${pad(230, "layout ")}จบ`,
    ],
  },
  { id: "synthetic-codex", prompts: SYNTHETIC_CODEX_PROMPTS },
  { id: "five-500", prompts: FIVE_LONG.map((text) => text.slice(0, 500)) },
  {
    id: "hostile",
    prompts: [
      "https://github.com/kemkem23/thumbmux/blob/main/svelte/src/PromptsPanel.svelte?plain=1#L1-L999",
      "/tmp/thumbmux-test-fixtures/adaptive-prompt-layout/portable-browser-proof.txt",
      "synthetic-token-NOT-A-REAL-CREDENTIAL-abcdefghijklmnopqrstuvwxyz0123456789-ZWJ👨‍👩‍👧-flag🇹🇭",
      "ประโยคไทยยาวไม่มีช่องว่างเพื่อทดสอบการตัดคำก้ำปั่นฐญและวรรณยุกต์ซ้อนกันทั้งก้อนนี้ต้องไม่ล้นแนวนอน",
      "line-one explicit\nline-two still here\nline-three ปิดด้วยไทย",
    ],
  },
];

export const HOST_CSS = `
  .hud-panel-stack {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 6px;
    min-width: 0;
  }
  .hud-panel-stack > .promptsp { min-width: 0; }
  .hud-meta-column {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
  }
  .session-recap-panel {
    min-width: 0;
    border: 1px solid var(--hud-line);
  }
  .notep {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 8px;
    padding: 6px 8px;
    border: 1px solid var(--hud-line);
  }
  .notep > .text { min-width: 0; }
  .notep > .ops { justify-content: flex-end; }
  .notep > .draft,
  .notep > .draft + .ops { grid-column: 1 / -1; }
  @media (min-width: 760px) {
    .hud-panel-stack {
      grid-template-columns: minmax(320px, 3fr) minmax(320px, 2fr);
      grid-template-rows: auto;
      column-gap: 12px;
    }
    .hud-panel-stack > .promptsp { grid-column: 1; grid-row: 1; }
    .hud-meta-column { grid-column: 2; grid-row: 1; }
  }
  @media (min-width: 1200px) and (max-height: 520px) {
    .hud-panel-stack {
      grid-template-columns: minmax(320px, 2fr) minmax(320px, 1fr) minmax(320px, 1fr);
      grid-template-rows: auto;
      column-gap: 12px;
    }
    .hud-panel-stack > .promptsp { grid-column: 1; grid-row: 1; }
    .hud-meta-column { display: contents; }
    .session-recap-panel { grid-column: 2; grid-row: 1; }
    .notep { grid-column: 3; grid-row: 1; }
  }
  .session-summary-panel { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; color: var(--hud-fg); }
  .summary-title {
    display: flex; align-items: baseline; gap: 6px;
    min-height: 32px; padding: 0; background: none; border: 0;
    color: var(--agent); font: 800 9px var(--font-thai, var(--font-mono));
    letter-spacing: .08em; text-align: left; cursor: pointer;
  }
  .summary-body {
    min-width: 0; margin: 0; color: var(--hud-fg);
    font: 600 12px var(--font-thai, var(--font-mono));
    line-height: 1.5; overflow-wrap: anywhere;
  }
  .session-cwd-panel {
    display: grid; grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline; gap: 8px; padding: 6px 8px;
    border-top: 1px solid var(--hud-line); color: var(--hud-fg);
  }
  .session-cwd-panel code {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 500 10px var(--font-mono);
  }
  .notep { font: 600 12px var(--font-thai, var(--font-mono)); color: var(--hud-fg); }
  .notep button { min-height: 44px; min-width: 44px; }
`;
