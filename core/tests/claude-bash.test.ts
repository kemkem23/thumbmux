import { describe, expect, test } from 'bun:test';

import {
  detectClaudeBashBlocks,
  detectClaudeBashBlocksWithActivityEvidence,
  groupClaudeBashBlocks,
  projectClaudeBashGroupedLines,
  projectClaudeBashLines,
} from '../src/claude-bash';
import { mergePrefs, type ThumbmuxPrefs } from '../src/prefs';

const completed = [
  '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(cd repo',
  "      sed -n '1,80p' src/a.ts)",
  '\x1b[38;5;246m  ⎿ \u00a0\x1b[39mfirst',
  '     rest',
  '\x1b[38;5;231m●\x1b[39m ต่อไป',
];

const active = [
  '\x1b[38;5;246m \x1b[39m \x1b[1mBash\x1b[0m(rg -n Bash src',
  '      tests)',
];

function paintedActivity(frame: string, verb = 'Thinking'): string {
  return `\x1b[38;5;174m${frame}\x1b[39m \x1b[38;5;174m${verb}…\x1b[39m `
    + '\x1b[38;5;246m(1m · ↓ 2k tokens · thinking with xhigh effort)\x1b[39m';
}

describe('Claude Bash detector', () => {
  test('detects completed ANSI physical rows with exact source/command/output ranges', () => {
    const result = detectClaudeBashBlocks(completed);
    expect(result.enabled).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      status: 'completed',
      sourceRange: { startLine: 0, endLine: 4 },
      commandRange: { startLine: 0, endLine: 2 },
      outputRange: { startLine: 2, endLine: 4 },
      command: "cd repo\nsed -n '1,80p' src/a.ts",
      output: 'first\nrest',
      commandTruncated: false,
      outputTruncated: false,
    });
    expect(result.blocks[0]?.fingerprint).toMatch(/^claude-bash-v1-[0-9a-f]{16}$/);
  });

  test('accepts the older completed ⏺ marker without requiring ANSI', () => {
    const lines = [
      '⏺ Bash(printf ok)',
      '  ⎿  ok',
      '● done',
    ];
    const [block] = detectClaudeBashBlocks(lines).blocks;
    expect(block?.status).toBe('completed');
    expect(block?.command).toBe('printf ok');
    expect(block?.output).toBe('ok');
  });

  test('uses styled grey-blank + bold Bash as the only active signature', () => {
    const [block] = detectClaudeBashBlocks(active).blocks;
    expect(block).toMatchObject({
      status: 'active',
      sourceRange: { startLine: 0, endLine: 2 },
      outputRange: { startLine: 2, endLine: 2 },
      command: 'rg -n Bash src\ntests',
    });

    expect(detectClaudeBashBlocks([
      '  Bash(rg -n Bash src',
      '      tests)',
    ]).blocks).toEqual([]);
    expect(detectClaudeBashBlocks([
      '\x1b[38;5;246m  Bash(rg -n Bash src)',
    ]).blocks).toEqual([]);
  });

  test('fails open when an active capture edge reaches an indented queued prompt', () => {
    const queuedPrompt = '  ❯ prompt ระหว่างที่ Bash ยัง active ต้องไม่หาย';
    const lines = [
      active[0]!,
      '      tests)',
      queuedPrompt,
    ];

    expect(detectClaudeBashBlocks(lines).blocks).toEqual([]);
    expect(projectClaudeBashLines(lines, { mode: 'hide' }).lines).toBe(lines);
  });

  test('uses a queued prompt only as a protective edge while Bash is still active', () => {
    const queuedPrompt = '  \x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m'
      + 'latest queued prompt\x1b[39m\x1b[49m';
    const firstLines = [
      ...active,
      '\x1b[38;5;246m  ⎿ \u00a0\x1b[39mfirst chunk',
      '',
      queuedPrompt,
    ];
    const secondLines = [
      ...active,
      '\x1b[38;5;246m  ⎿ \u00a0\x1b[39mfirst chunk',
      '     second chunk',
      '',
      queuedPrompt,
    ];
    const first = detectClaudeBashBlocks(firstLines);
    const second = detectClaudeBashBlocks(secondLines);

    expect(first.blocks[0]).toMatchObject({
      status: 'active',
      sourceRange: { startLine: 0, endLine: 3 },
      output: 'first chunk',
    });
    expect(second.blocks[0]).toMatchObject({
      status: 'active',
      sourceRange: { startLine: 0, endLine: 4 },
      output: 'first chunk\nsecond chunk',
    });
    expect(second.blocks[0]?.fingerprint).toBe(first.blocks[0]?.fingerprint);

    const firstHaiku = projectClaudeBashGroupedLines(firstLines, {
      mode: 'haiku',
      detection: first,
    });
    const secondHaiku = projectClaudeBashGroupedLines(secondLines, {
      mode: 'haiku',
      detection: second,
    });
    expect(firstHaiku.rows[0]).toMatchObject({
      kind: 'bash-placeholder',
      status: 'active',
      line: 'Bash กำลังรัน…',
      rawRange: { startLine: 0, endLine: 4 },
      summaryState: 'none',
    });
    expect(secondHaiku.rows[0]).toMatchObject({
      kind: 'bash-placeholder',
      status: 'active',
      line: 'Bash กำลังรัน…',
      rawRange: { startLine: 0, endLine: 5 },
      summaryState: 'none',
    });
    expect(secondHaiku.detectedGroups[0]?.fingerprint)
      .toBe(firstHaiku.detectedGroups[0]?.fingerprint);
    expect(firstHaiku.lines).toEqual(['Bash กำลังรัน…', queuedPrompt]);
    expect(secondHaiku.lines).toEqual(['Bash กำลังรัน…', queuedPrompt]);
    expect(firstHaiku.summaryRequests).toEqual([]);
    expect(secondHaiku.summaryRequests).toEqual([]);
  });

  test('keeps every Claude thinking-animation frame outside completed Bash output', () => {
    const spinnerFrames = ['·', '✻', '✽', '✶', '✳', '✢'];
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;

    for (const frame of spinnerFrames) {
      const thinking = paintedActivity(frame);
      const lines = [
        '● Bash(printf done)',
        '  ⎿  done',
        thinking,
        '',
        composerRule,
        '❯ queued follow-up',
        composerRule,
      ];

      const [block] = detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks;
      expect(block?.sourceRange, `frame ${frame}`).toEqual({ startLine: 0, endLine: 2 });
      expect(projectClaudeBashLines(lines, {
        mode: 'hide',
        detection: detectClaudeBashBlocksWithActivityEvidence(lines, [2]),
      }).lines, `frame ${frame}`).toEqual([
        'Bash ซ่อนอยู่ · 2 แถว',
        thinking,
        ...lines.slice(3),
      ]);
      const distilled = projectClaudeBashLines(lines, {
        mode: 'haiku',
        detection: detectClaudeBashBlocksWithActivityEvidence(lines, [2]),
      });
      expect(distilled.lines[1], `distill frame ${frame}`).toBe(thinking);
      expect(distilled.summaryRequests, `distill frame ${frame}`).toEqual([
        expect.objectContaining({ command: 'printf done', output: 'done', lineCount: 2 }),
      ]);
      expect(JSON.stringify(distilled.summaryRequests), `distill frame ${frame}`)
        .not.toContain('Thinking');
    }
  });

  test('keeps the old API fail-open and requires positional evidence for activity detection', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done',
      paintedActivity('✢'),
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];

    expect(detectClaudeBashBlocks(lines).blocks).toEqual([]);
    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks[0]?.sourceRange)
      .toEqual({ startLine: 0, endLine: 2 });
  });

  test('keeps every Claude thinking-animation frame outside an active Bash tail', () => {
    const spinnerFrames = ['·', '✻', '✽', '✶', '✳', '✢'];
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;

    for (const frame of spinnerFrames) {
      const thinking = paintedActivity(frame);
      const lines = [
        active[0]!,
        '  ⎿  command completed; Claude is thinking about the result',
        thinking,
        '',
        composerRule,
        '❯ queued follow-up',
        composerRule,
      ];
      const projection = projectClaudeBashLines(lines, {
        mode: 'hide',
        detection: detectClaudeBashBlocksWithActivityEvidence(lines, [2]),
      });

      expect(projection.detectedBlocks[0]?.sourceRange, `frame ${frame}`)
        .toEqual({ startLine: 0, endLine: 2 });
      expect(projection.lines[1], `frame ${frame}`).toBe(thinking);
      expect(projection.rawToVisualRow[2], `frame ${frame}`).toBe(1);
    }
  });

  test('fails open when an active capture ends on an unconfirmed activity row', () => {
    for (const frame of ['●', '·', '✻', '✽', '✶', '✳', '✢']) {
      const cases = [
        paintedActivity(frame),
        `\x1b[38;5;246m${frame}\x1b[39m Thinking… (thinking with xhigh effort)`,
        `${frame} Thinking… (thinking with xhigh effort)`,
      ];
      for (const status of cases) {
        const lines = [
          active[0]!,
          '  ⎿  command completed',
          status,
        ];
        expect(detectClaudeBashBlocks(lines).blocks, status).toEqual([]);
        expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks, status)
          .toEqual([]);
        expect(projectClaudeBashLines(lines, {
          mode: 'hide',
          detection: detectClaudeBashBlocksWithActivityEvidence(lines, [2]),
        }).lines, status).toBe(lines);
      }
    }
  });

  test('keeps every legacy 246-marker activity frame stable after repaint proof', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    for (const frame of ['·', '✻', '✽', '✶', '✳', '✢']) {
      const thinking = `\x1b[38;5;246m${frame}\x1b[39m Thinking… `
        + '(thinking with xhigh effort)';
      const lines = [
        '● Bash(printf done)',
        '  ⎿  done',
        thinking,
        composerRule,
        '❯ queued follow-up',
        composerRule,
      ];

      expect(detectClaudeBashBlocks(lines).blocks, frame).toEqual([]);
      expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks[0]?.sourceRange,
        frame).toEqual({ startLine: 0, endLine: 2 });
      expect(projectClaudeBashLines(lines, {
        mode: 'hide',
        detection: detectClaudeBashBlocksWithActivityEvidence(lines, [2]),
      }).lines[1], frame).toBe(thinking);
    }
  });

  test('accepts the measured live 174/246 activity paint before paired composer chrome', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const thinking = '\x1b[38;5;174m●\x1b[39m \x1b[38;5;174mSpinning…\x1b[39m '
      + '\x1b[38;5;246m(7m 9s · ↓ 38.3k tokens · thinking with max effort)\x1b[39m   ';
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done',
      '',
      thinking,
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];

    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [3]).blocks[0]?.sourceRange)
      .toEqual({ startLine: 0, endLine: 2 });
    expect(projectClaudeBashLines(lines, {
      mode: 'hide',
      detection: detectClaudeBashBlocksWithActivityEvidence(lines, [3]),
    }).lines).toEqual([
      'Bash ซ่อนอยู่ · 2 แถว',
      '',
      thinking,
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ]);
  });

  test('treats submitted prompt echoes at columns zero through two as protective boundaries', () => {
    for (const indent of ['', ' ', '  ']) {
      const queuedPrompt = `${indent}\x1b[38;5;239m\x1b[48;5;237m❯ `
        + '\x1b[38;5;231mprompt ล่าสุดของผู้ใช้ต้องไม่หาย\x1b[39m\x1b[49m';
      const lines = [
        '● Bash(printf done)',
        '  ⎿  done',
        '',
        queuedPrompt,
        '\x1b[38;5;231m●\x1b[39m ตอบคำถามถัดไป',
      ];

      const detection = detectClaudeBashBlocks(lines);
      expect(detection.blocks[0]?.sourceRange, JSON.stringify(indent))
        .toEqual({ startLine: 0, endLine: 2 });
      expect(detection.blocks[0]?.output, JSON.stringify(indent)).not.toContain('prompt ล่าสุด');

      const projection = projectClaudeBashLines(lines, { mode: 'hide', detection });
      expect(projection.lines, JSON.stringify(indent)).toContain(queuedPrompt);
    }
  });

  test('never lets proven activity hide a queued prompt or its wrapped continuation', () => {
    const queuedPrompt = '  \x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m'
      + 'prompt ล่าสุดของผู้ใช้ต้องไม่หาย\x1b[39m\x1b[49m';
    const continuation = '     และบรรทัดต่อของ prompt ต้องยังอยู่';
    const composerRule = `\x1b[38;5;244m${'─'.repeat(110)}`;
    const thinking = '\x1b[38;5;174m✽\x1b[39m \x1b[38;5;174mTransfiguring…\x1b[39m '
      + '\x1b[38;5;246m(6m 56s · ↓ 20.9k tokens)\x1b[39m';
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done',
      '',
      queuedPrompt,
      continuation,
      thinking,
      '',
      composerRule,
      '\x1b[38;5;244m❯ Press up to edit queued messages',
      composerRule,
    ];

    const detection = detectClaudeBashBlocksWithActivityEvidence(lines, [5]);
    expect(detection.blocks[0]?.sourceRange).toEqual({ startLine: 0, endLine: 2 });
    expect(detection.blocks[0]?.output).not.toContain('prompt ล่าสุด');

    const projection = projectClaudeBashLines(lines, { mode: 'hide', detection });
    expect(projection.lines).toContain(queuedPrompt);
    expect(projection.lines).toContain(continuation);
    expect(projection.lines).toContain(thinking);
  });

  test('protects Bash-shaped prompt continuation without disabling real styled Bash', () => {
    const queuedPrompt = '  \x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m'
      + 'review this literal transcript\x1b[39m\x1b[49m';
    const lines = [
      queuedPrompt,
      '  the following Bash transcript is user-authored text',
      '● Bash(printf literal-user-text)',
      '  ⎿  literal result must remain prompt text',
      '     literal tail must remain prompt text',
      '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf real)',
      '  ⎿  real result',
      '\x1b[38;5;231m●\x1b[39m done',
    ];
    const detection = detectClaudeBashBlocks(lines);

    expect(detection.blocks).toHaveLength(1);
    expect(detection.blocks[0]).toMatchObject({
      status: 'completed',
      rawStart: 5,
      rawEndExclusive: 7,
      command: 'printf real',
      output: 'real result',
    });
    const projection = projectClaudeBashGroupedLines(lines, {
      mode: 'hide',
      detection,
    });
    expect(projection.rows[2]).toMatchObject({
      kind: 'raw',
      rawRange: { startLine: 2, endLine: 3 },
    });
    expect(projection.rows[5]).toMatchObject({
      kind: 'bash-placeholder',
      rawRange: { startLine: 5, endLine: 7 },
    });
    expect(projection.rawToVisualRow).toEqual([0, 1, 2, 3, 4, 5, 5, 6]);

    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const afterComposerBottom = [
      composerRule,
      '\x1b[38;5;244m❯ Press up to edit queued messages',
      composerRule,
      ...lines,
    ];
    const afterComposerDetection = detectClaudeBashBlocks(afterComposerBottom);
    expect(afterComposerDetection.blocks).toHaveLength(1);
    expect(afterComposerDetection.blocks[0]?.sourceRange)
      .toEqual({ startLine: 8, endLine: 10 });
    expect(projectClaudeBashGroupedLines(afterComposerBottom, {
      mode: 'hide',
      detection: afterComposerDetection,
    }).rows.find((row) => row.rawStart === 5)).toMatchObject({
      kind: 'raw',
      rawRange: { startLine: 5, endLine: 6 },
    });

    const activeAfterPrompt = detectClaudeBashBlocks([queuedPrompt, ...active]);
    expect(activeAfterPrompt.blocks[0]).toMatchObject({
      status: 'active',
      sourceRange: { startLine: 1, endLine: 3 },
    });

    const seamDetection = detectClaudeBashBlocks(lines, {
      maxScanLines: lines.length - 1,
    });
    expect(seamDetection.scanRange).toEqual({ startLine: 1, endLine: lines.length });
    expect(seamDetection.blocks).toHaveLength(1);
    expect(seamDetection.blocks[0]?.sourceRange).toEqual({ startLine: 5, endLine: 7 });

    const olderStyledHeader = '\x1b[38;5;114m⏺\x1b[39m \x1b[1mBash\x1b[0m(printf older-real)';
    const olderStyled = [
      queuedPrompt,
      olderStyledHeader,
      '  ⎿  older real output',
      '\x1b[38;5;231m●\x1b[39m done',
    ];
    const olderAfterPrompt = detectClaudeBashBlocks(olderStyled);
    expect(olderAfterPrompt.blocks[0]?.sourceRange).toEqual({ startLine: 1, endLine: 3 });
    const olderAtScanSeam = detectClaudeBashBlocks(olderStyled, { maxScanLines: 3 });
    expect(olderAtScanSeam.scanRange).toEqual({ startLine: 1, endLine: 4 });
    expect(olderAtScanSeam.blocks[0]?.sourceRange).toEqual({ startLine: 1, endLine: 3 });

    const longPrompt = [
      queuedPrompt,
      ...Array.from({ length: 64 }, (_, index) => `  continuation ${index}`),
      '● Bash(printf prompt-owned-after-old-cap)',
      '  ⎿  prompt-owned output after old cap',
      composerRule,
      '\x1b[38;5;244m❯ Press up to edit queued messages',
      composerRule,
    ];
    const longDetection = detectClaudeBashBlocks(longPrompt);
    expect(longDetection.blocks).toEqual([]);
    const longProjection = projectClaudeBashGroupedLines(longPrompt, {
      mode: 'haiku',
      detection: longDetection,
    });
    expect(longProjection.lines).toEqual(longPrompt);
    expect(longProjection.summaryRequests).toEqual([]);
  });

  test('does not treat a later bold Bash word as styled header proof', () => {
    const queuedPrompt = '  \x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m'
      + 'review this ANSI transcript\x1b[39m\x1b[49m';

    for (const marker of ['●', '⏺']) {
      const lines = [
        queuedPrompt,
        `\x1b[38;5;231m${marker}\x1b[39m Bash(prompt-owned; later label \x1b[1mBash\x1b[0m)`,
        '  ⎿  prompt-owned output',
        '\x1b[38;5;231m●\x1b[39m apparent boundary',
      ];

      const detection = detectClaudeBashBlocks(lines);
      expect(detection.blocks, marker).toEqual([]);
      expect(projectClaudeBashGroupedLines(lines, {
        mode: 'hide',
        detection,
      }).lines).toEqual(lines);
    }
  });

  test('keeps status-shaped plain and ANSI shell output inside HIDE and DISTILL payloads', () => {
    const shellRows = [
      '✽ Reading app.log',
      '\x1b[38;5;246m✽\x1b[39m Reading app.log',
      '✳ Writing a report',
      '· Done for 3m',
      '\x1b[38;5;246m*\x1b[39m shell spinner-shaped output',
    ];

    for (const shellRow of shellRows) {
      const lines = [
        '● Bash(printf marker-like-output)',
        '  ⎿  first',
        shellRow,
        'tail remains part of command output',
        '● real Claude boundary',
      ];
      const detection = detectClaudeBashBlocks(lines);
      expect(detection.blocks[0]?.sourceRange, shellRow).toEqual({ startLine: 0, endLine: 4 });
      expect(detection.blocks[0]?.output, shellRow).toContain('tail remains part of command output');

      const distilled = projectClaudeBashGroupedLines(lines, { mode: 'haiku', detection });
      expect(distilled.summaryRequests, shellRow).toEqual([
        expect.objectContaining({
          output: expect.stringContaining('tail remains part of command output'),
          lineCount: 4,
        }),
      ]);
    }

    const ambiguousStatuses = [
      '* Ruminating… (1m 1s · almost done thinking with max effort)',
      '\x1b[38;5;246m✢\x1b[39m Thinking… (thinking with xhigh effort)',
    ];
    for (const ambiguousStatus of ambiguousStatuses) {
      const ambiguousLines = [
        '● Bash(printf marker-like-output)',
        '  ⎿  first',
        ambiguousStatus,
        'tail remains part of command output',
        '● real Claude boundary',
      ];
      expect(detectClaudeBashBlocks(ambiguousLines).blocks, ambiguousStatus).toEqual([]);
      expect(projectClaudeBashLines(ambiguousLines, { mode: 'haiku' }).lines, ambiguousStatus)
        .toBe(ambiguousLines);
    }
  });

  test('keeps controlled ANSI/OSC status bytes raw and splits Bash groups across status repaint rows', () => {
    const ansiStatus = '\x1b]0;thinking\x1b\\\x1b[?25l' + paintedActivity('✢') + '\x1b[?25h';
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const lines = [
      '● Bash(printf first)',
      '  ⎿  first-output',
      ansiStatus,
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
      '● Bash(printf second)',
      '  ⎿  second-output',
      '● final response',
    ];
    const detection = detectClaudeBashBlocksWithActivityEvidence(lines, [2]);
    expect(detection.blocks.map((block) => block.sourceRange)).toEqual([
      { startLine: 0, endLine: 2 },
      { startLine: 7, endLine: 9 },
    ]);
    expect(groupClaudeBashBlocks(lines, detection.blocks)).toHaveLength(2);

    const projection = projectClaudeBashGroupedLines(lines, { mode: 'hide', detection });
    expect(projection.lines).toEqual([
      'Bash ซ่อนอยู่ · 2 แถว',
      ansiStatus,
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
      'Bash ซ่อนอยู่ · 2 แถว',
      '● final response',
    ]);
    expect(projection.rows[1]).toMatchObject({
      kind: 'raw',
      line: ansiStatus,
      rawStart: 2,
      rawEndExclusive: 3,
    });
  });

  test('does not skip an ordinary shell tail while seeking later composer chrome', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const statusShapedOutput = '\x1b[38;5;246m✢\x1b[39m Thinking… '
      + '(1m · ↓ 2k tokens · thinking with max effort)';
    const lines = [
      '● Bash(printf status-shaped-output)',
      '  ⎿  first',
      statusShapedOutput,
      'ordinary tail must remain in the Bash payload',
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];

    const detection = detectClaudeBashBlocks(lines);
    expect(detection.blocks).toEqual([]);
    expect(projectClaudeBashLines(lines, { mode: 'haiku' }).lines).toBe(lines);
  });

  test('fails open for a one-frame status-shaped shell tail until repaint evidence exists', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const cases = [
      paintedActivity('✢'),
    ];

    for (const statusShapedOutput of cases) {
      const lines = [
        '● Bash(printf final-status-shaped-row)',
        '  ⎿  first',
        statusShapedOutput,
        '',
        composerRule,
        '❯ queued follow-up',
        composerRule,
      ];

      expect(detectClaudeBashBlocks(lines).blocks, statusShapedOutput).toEqual([]);
      expect(projectClaudeBashLines(lines, { mode: 'haiku' }).lines, statusShapedOutput)
        .toBe(lines);

      const confirmed = detectClaudeBashBlocksWithActivityEvidence(lines, [2]);
      expect(confirmed.blocks[0]?.sourceRange, statusShapedOutput)
        .toEqual({ startLine: 0, endLine: 2 });
      expect(confirmed.blocks[0]?.output, statusShapedOutput).toBe('first');
    }
  });

  test('fails open for styled bullet frames without nearby paired composer chrome', () => {
    for (const frame of ['●', '✻', '✢']) {
      const lines = [
        '● Bash(printf final-status-shaped-row)',
        '  ⎿  first',
        paintedActivity(frame),
        '● real Claude response',
      ];

      expect(detectClaudeBashBlocks(lines).blocks, frame).toEqual([]);
      expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks, frame)
        .toEqual([]);
      expect(projectClaudeBashLines(lines, { mode: 'haiku' }).lines, frame).toBe(lines);
    }
  });

  test('fails open for plain or non-Claude-painted semantic activity markers', () => {
    const cases = [
      ...['●', '✻', '✢'].map((frame) =>
        `${frame} Thinking… (thinking with xhigh effort)`),
      '\x1b[38;5;196m●\x1b[39m Thinking… (thinking with xhigh effort)',
      '\x1b[38;5;246m✻ Thinking… (thinking with xhigh effort)',
    ];
    for (const status of cases) {
      const lines = [
        '● Bash(printf final-status-shaped-row)',
        '  ⎿  first',
        status,
        'ordinary tail must survive',
        '● real Claude response',
      ];

      expect(detectClaudeBashBlocks(lines).blocks, status).toEqual([]);
      expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks, status)
        .toEqual([]);
      expect(projectClaudeBashLines(lines, { mode: 'haiku' }).lines, status).toBe(lines);
    }
  });

  test('accepts equivalent measured composer paint across tmux SGR segmentation', () => {
    const rules = [
      `\x1b[0m\x1b[38;5;244m${'─'.repeat(80)}`,
      `\x1b[0;38;5;244m${'─'.repeat(80)}\x1b[39m`,
      `\x1b[49m\x1b[38:5:244m${'─'.repeat(80)}`,
      `\x1b[38;5;244m${'─'.repeat(40)}\x1b[38;5;244m${'─'.repeat(40)}\x1b[39m`,
    ];
    const composerPrompt = '\x1b[38;5;244m❯ queued follow-up';
    for (const composerRule of rules) {
      const lines = [
        '● Bash(printf done)',
        '  ⎿  done',
        paintedActivity('✢'),
        '',
        composerRule,
        composerPrompt,
        composerRule,
      ];
      expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks[0]?.sourceRange,
        composerRule).toEqual({ startLine: 0, endLine: 2 });
    }

    const mixedRule = `\x1b[38;5;244m${'─'.repeat(40)}\x1b[38;5;196m${'─'.repeat(40)}`;
    expect(detectClaudeBashBlocksWithActivityEvidence([
      '● Bash(printf done)',
      '  ⎿  done',
      paintedActivity('✢'),
      '',
      mixedRule,
      '❯ queued follow-up',
      mixedRule,
    ], [2]).blocks).toEqual([]);

    const inverseRule = `\x1b[38;5;244;48;5;196;7m${'─'.repeat(80)}`;
    expect(detectClaudeBashBlocksWithActivityEvidence([
      '● Bash(printf done)',
      '  ⎿  done',
      paintedActivity('✢'),
      '',
      inverseRule,
      '❯ queued follow-up',
      inverseRule,
    ], [2]).blocks).toEqual([]);
  });

  test('rejects paired composer rules when the prompt row is not 244-painted', () => {
    const topRule = `\x1b[38;5;244m${'─'.repeat(80)}\x1b[39m`;
    const bottomRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done',
      paintedActivity('✢'),
      '',
      topRule,
      '❯ shell prompt-shaped output',
      bottomRule,
    ];

    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks).toEqual([]);
  });

  test('accepts a bottom composer rule which inherits 244 paint across rows', () => {
    const topRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const bottomRule = '─'.repeat(80);
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done',
      paintedActivity('✢'),
      '',
      topRule,
      '❯ queued follow-up',
      bottomRule,
    ];

    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks[0]?.sourceRange)
      .toEqual({ startLine: 0, endLine: 2 });

    // Resetting the inherited foreground before the bottom row makes the same
    // visible glyphs ordinary unpainted output, so the identity check rejects.
    lines[5] = '\x1b[39m❯ queued follow-up';
    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks).toEqual([]);
  });

  test('accepts a top composer rule which inherits 244 from a preceding blank row', () => {
    const rule = '─'.repeat(80);
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done',
      paintedActivity('✢'),
      '\x1b[38;5;244m',
      rule,
      '❯ queued follow-up',
      rule,
    ];

    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks[0]?.sourceRange)
      .toEqual({ startLine: 0, endLine: 2 });
  });

  test('rejects activity paint while inverse rendition is inherited from shell output', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done\x1b[7m',
      paintedActivity('✢'),
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];

    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks).toEqual([]);
  });

  test('rejects inherited activity paint after malformed ESC carry', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const lines = [
      '● Bash(printf done)',
      '  ⎿  done\x1b[38;5;174mX\x1b[1\x1b[0m',
      '✢ Thinking… \x1b[38;5;246m(thinking with xhigh effort)\x1b[39m',
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];

    expect(detectClaudeBashBlocksWithActivityEvidence(lines, [2]).blocks).toEqual([]);
  });

  test('keeps an ordinary coloured download meter in the final DISTILL payload', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const download = '\x1b[38;5;246m*\x1b[39m Downloading… (↓ 12 MB/s)';
    const lines = [
      '● Bash(printf download-progress)',
      '  ⎿  connected',
      download,
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];
    const detection = detectClaudeBashBlocks(lines);
    expect(detection.blocks[0]?.sourceRange).toEqual({ startLine: 0, endLine: 3 });
    expect(detection.blocks[0]?.output).toBe('connected\n* Downloading… (↓ 12 MB/s)');
    expect(projectClaudeBashGroupedLines(lines, { mode: 'haiku', detection }).summaryRequests)
      .toEqual([expect.objectContaining({
        output: 'connected\n* Downloading… (↓ 12 MB/s)',
        lineCount: 4,
      })]);
  });

  test('does not mistake background RGB operands for Claude foreground paint', () => {
    const composerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const backgroundOnly = '\x1b[48;2;38;5;174m✢ Thinking… '
      + '(1m · ↓ 2k tokens · thinking with max effort)';
    const lines = [
      '● Bash(printf background-colour)',
      '  ⎿  first',
      backgroundOnly,
      '',
      composerRule,
      '❯ queued follow-up',
      composerRule,
    ];

    const detection = detectClaudeBashBlocks(lines);
    expect(detection.blocks).toEqual([]);
    expect(projectClaudeBashLines(lines, { mode: 'haiku' }).lines).toBe(lines);
  });

  test('promotes a stale grey header when result plus later boundary proves completion', () => {
    const staleRepaint = [
      '\x1b[38;5;246m \x1b[39m \x1b[1mBash\x1b[0m(bun test)',
      '\x1b[38;5;246m  ⎿ \u00a0\x1b[39m16 pass',
      '● ทำงานถัดไป',
    ];
    const [block] = detectClaudeBashBlocks(staleRepaint).blocks;
    expect(block?.status).toBe('completed');
    expect(block?.output).toBe('16 pass');
    expect(projectClaudeBashLines(staleRepaint, { mode: 'haiku' }).summaryRequests)
      .toHaveLength(1);
  });

  test('fails open for missing header, result delimiter, or completed boundary', () => {
    const cases = [
      ['      printf orphan)', '  ⎿  orphan', '● next'],
      ['● Bash(printf no-result)', '● next'],
      ['● Bash(printf cut)', '  ⎿  cut'],
    ];
    for (const lines of cases) expect(detectClaudeBashBlocks(lines).blocks).toEqual([]);
  });

  test('does not end a command on nested parens/heredoc and uses the first result marker', () => {
    const lines = [
      '● Bash(cat <<\'EOF\'',
      '      $(printf nested)',
      '',
      '      EOF)',
      '  ⎿  one',
      '  ⎿  Shell cwd was reset to /repo',
      '     tail',
      '● next',
    ];
    const [block] = detectClaudeBashBlocks(lines).blocks;
    expect(block?.commandRange).toEqual({ startLine: 0, endLine: 4 });
    expect(block?.outputRange).toEqual({ startLine: 4, endLine: 7 });
    expect(block?.command).toContain('$(printf nested)');
    expect(block?.command).toContain('EOF');
    expect(block?.output).toBe('one\nShell cwd was reset to /repo\ntail');
  });

  test('keeps soft-wrapped Bash tables and rules after the result delimiter intact', () => {
    const paneColumns = 80;
    const composerRule = `\x1b[38;5;244m${'─'.repeat(paneColumns)}`;
    const continuations = [
      ['─'.repeat(paneColumns - 5), '─'.repeat(24), '│ wide table result │', '└────────────────────┘'],
      ['┌' + '─'.repeat(paneColumns - 6), '─'.repeat(20) + '┐', '│ another result │', '└─────────────────┘'],
      ['-'.repeat(paneColumns - 5), '-'.repeat(24), 'plain output after rule'],
      ['界'.repeat(37) + 'ก', '┌────────────────────', '│ Unicode-width result │', '└────────────────────┘'],
    ];

    for (const continuation of continuations) {
      const lines = [
        '● Bash(render-wide-table)',
        `  ⎿  ${continuation[0]}`,
        ...continuation.slice(1),
        '\x1b[38;5;231m●\x1b[39m next',
        composerRule,
        '❯ ',
        composerRule,
      ];
      const [block] = detectClaudeBashBlocks(lines).blocks;
      expect(block?.sourceRange).toEqual({ startLine: 0, endLine: lines.length - 4 });
      expect(block?.output).toContain(continuation.at(-1)!);

      const projection = projectClaudeBashLines(lines, { mode: 'hide' });
      expect(projection.rows[0]?.rawRange).toEqual({ startLine: 0, endLine: lines.length - 4 });
      expect(projection.lines).toHaveLength(5);
      expect(projection.lines[1]).toContain('●');
    }

    const unstyledAfterAmbiguity = [
      '● Bash(render-wide-table)',
      `  ⎿  ${'─'.repeat(paneColumns - 5)}`,
      '─'.repeat(20),
      '● could also be output',
      composerRule,
      '❯ ',
      composerRule,
    ];
    expect(detectClaudeBashBlocks(unstyledAfterAmbiguity).blocks).toEqual([]);
  });

  test('keeps soft-wrapped marker-shaped shell output inside one Bash block', () => {
    const paneColumns = 80;
    const composerRule = `\x1b[38;5;244m${'─'.repeat(paneColumns)}`;
    const markerOutputs = [
      { raw: '● shell bullet', visible: '● shell bullet' },
      { raw: '✻ shell spinner-shaped output', visible: '✻ shell spinner-shaped output' },
      { raw: '\x1b[31m● red shell bullet\x1b[0m', visible: '● red shell bullet' },
    ];

    for (const markerOutput of markerOutputs) {
      const lines = [
        '● Bash(render-marker-output)',
        `  ⎿  ${'x'.repeat(paneColumns - 5)}`,
        markerOutput.raw,
        'tail after marker-shaped output',
        '\x1b[38;5;231m●\x1b[39m real Claude boundary',
        composerRule,
        '❯ ',
        composerRule,
      ];
      const detection = detectClaudeBashBlocks(lines);
      expect(detection.blocks).toHaveLength(1);
      expect(detection.blocks[0]?.sourceRange).toEqual({ startLine: 0, endLine: 4 });
      expect(detection.blocks[0]?.output).toContain(markerOutput.visible);
      expect(detection.blocks[0]?.output).toContain('tail after marker-shaped output');
      expect(projectClaudeBashLines(lines, { mode: 'hide' }).rows[0]?.rawRange)
        .toEqual({ startLine: 0, endLine: 4 });
    }

    // Prompt-shaped bytes immediately after a full-width result are
    // indistinguishable from a submitted prompt at a soft-wrap seam. Preserve
    // the complete candidate rather than hiding either interpretation.
    const ambiguousPrompt = [
      '● Bash(render-marker-output)',
      `  ⎿  ${'x'.repeat(paneColumns - 5)}`,
      '❯ shell prompt-shaped output',
      'tail after prompt-shaped output',
      '\x1b[38;5;231m●\x1b[39m real Claude boundary',
      composerRule,
      '❯ ',
      composerRule,
    ];
    expect(detectClaudeBashBlocks(ambiguousPrompt).blocks).toEqual([]);
    expect(projectClaudeBashLines(ambiguousPrompt, { mode: 'hide' }).lines)
      .toBe(ambiguousPrompt);
  });

  test('fails open after ambiguous wraps instead of trusting arbitrary SGR or approval choices', () => {
    const paneColumns = 80;
    const composerRule = `\x1b[38;5;244m${'─'.repeat(paneColumns)}`;
    const colouredOutputAfterRule = [
      '● Bash(render-rule-and-bullet)',
      `  ⎿  ${'x'.repeat(paneColumns - 5)}`,
      '─'.repeat(24),
      '\x1b[31m● red shell bullet\x1b[0m',
      '\x1b[38;5;231m●\x1b[39m real Claude boundary',
      composerRule,
      '❯ ',
      composerRule,
    ];
    expect(detectClaudeBashBlocks(colouredOutputAfterRule).blocks).toEqual([]);
    expect(projectClaudeBashLines(colouredOutputAfterRule, { mode: 'hide' }).lines)
      .toBe(colouredOutputAfterRule);

    const approvalAfterFullRow = [
      '● Bash(dangerous-command)',
      `  ⎿  ${'x'.repeat(paneColumns - 5)}`,
      '╭─ command requires confirmation',
      '│ Do you want to proceed?',
      '\x1b[31m❯ 1. Yes\x1b[0m',
      '╰────────────────────────',
      '\x1b[38;5;231m●\x1b[39m later Claude response',
      composerRule,
      '❯ ',
      composerRule,
    ];
    expect(detectClaudeBashBlocks(approvalAfterFullRow).blocks).toEqual([]);
    expect(projectClaudeBashLines(approvalAfterFullRow, { mode: 'hide' }).lines)
      .toBe(approvalAfterFullRow);
  });

  test('does not split a fake Bash header emitted by a full-width result row', () => {
    const paneColumns = 80;
    const composerRule = `\x1b[38;5;244m${'─'.repeat(paneColumns)}`;
    const lines = [
      '● Bash(print-Claude-looking-output)',
      `  ⎿  ${'x'.repeat(paneColumns - 5)}`,
      '● Bash(fake-output)',
      '  ⎿  fake delimiter is still outer command output',
      'fake tail',
      '\x1b[38;5;231m●\x1b[39m real Claude boundary',
      composerRule,
      '❯ ',
      composerRule,
    ];
    const detection = detectClaudeBashBlocks(lines);
    expect(detection.blocks).toHaveLength(1);
    expect(detection.blocks[0]?.sourceRange).toEqual({ startLine: 0, endLine: 5 });
    expect(detection.blocks[0]?.output).toContain('● Bash(fake-output)');
    expect(detection.blocks[0]?.output).toContain('fake delimiter is still outer command output');
  });

  test('fails open on marker-shaped history when pane width is absent, stale, or space-trimmed', () => {
    const calibratedBoundary = '\x1b[38;5;231m●\x1b[39m real Claude boundary';
    const markerOutputs = [
      '● shell bullet',
      '❯ shell prompt-shaped output',
      '✻ shell spinner-shaped output',
      '\x1b[31m● red shell bullet\x1b[0m',
    ];

    for (const [historicalColumns, currentColumns] of [
      [80, 240],
      [240, 80],
      [80, 126],
      [126, 80],
    ] as const) {
      const composerRule = `\x1b[38;5;244m${'─'.repeat(currentColumns)}`;
      for (const markerOutput of markerOutputs) {
        const lines = [
          '● Bash(render-old-geometry)',
          `  ⎿  ${'x'.repeat(historicalColumns - 5)}`,
          markerOutput,
          'tail after marker-shaped output',
          calibratedBoundary,
          composerRule,
          '❯ ',
          composerRule,
        ];
        expect(detectClaudeBashBlocks(lines).blocks).toEqual([]);
        expect(projectClaudeBashLines(lines, { mode: 'hide' }).lines).toBe(lines);
      }
    }

    const noComposerCalibration = [
      '● Bash(render-retained-segment)',
      `  ⎿  ${'x'.repeat(75)}`,
      '● shell bullet in an isolated history segment',
      'tail after marker-shaped output',
      calibratedBoundary,
    ];
    expect(detectClaudeBashBlocks(noComposerCalibration).blocks).toEqual([]);

    // Some capture paths preserve these spaces and others trim them. In both
    // cases the 75 visible cells are still wide enough to be an old soft-wrap;
    // never use the following shell marker to hide only the candidate prefix.
    const currentComposerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const trailingSpaces = [
      '● Bash(render-space-padded-row)',
      `  ⎿  ${'x'.repeat(70)}${' '.repeat(5)}`,
      '● shell bullet after trailing spaces',
      'tail after marker-shaped output',
      calibratedBoundary,
      currentComposerRule,
      '❯ ',
      currentComposerRule,
    ];
    expect(detectClaudeBashBlocks(trailingSpaces).blocks).toEqual([]);
    expect(projectClaudeBashLines(trailingSpaces, { mode: 'hide' }).lines)
      .toBe(trailingSpaces);
  });

  test('fails open for exact Claude-looking shell bytes and unknown rounded dialogs', () => {
    const paneColumns = 80;
    const fullResult = `  ⎿  ${'x'.repeat(paneColumns - 5)}`;
    const composerRule = `\x1b[38;5;244m${'─'.repeat(paneColumns)}`;
    const composer = [composerRule, '\x1b[39m❯ ', composerRule];
    const boundary = (text: string) => `\x1b[38;5;231m●\x1b[39m ${text}`;
    const fixtures = [
      [
        '● Bash(emit-exact-composer)',
        fullResult,
        ...composer,
        'shell tail after fake composer',
        boundary('real Claude response'),
        ...composer,
      ],
      [
        '● Bash(emit-exact-marker)',
        fullResult,
        boundary('shell-emitted marker'),
        'shell tail after fake marker',
        boundary('real Claude response'),
        ...composer,
      ],
      [
        '● Bash(emit-exact-header)',
        fullResult,
        '\x1b[38;5;231m●\x1b[39m Bash(fake)',
        '  ⎿  fake delimiter is shell output',
        boundary('real Claude response'),
        ...composer,
      ],
      [
        '● Bash(emit-repeated-exact-headers)',
        fullResult,
        '\x1b[38;5;231m●\x1b[39m Bash(fake-one)',
        '  ⎿  first fake delimiter is shell output',
        '\x1b[38;5;231m●\x1b[39m Bash(fake-two)',
        '  ⎿  second fake delimiter is shell output',
        boundary('real Claude response'),
        ...composer,
      ],
      [
        '● Bash(long-result-before-new-dialog)',
        fullResult,
        '╭─ New Claude UI prompt',
        '│ Continue with experimental action?',
        '│ press enter to proceed',
        '╰────────────────────────',
        boundary('real Claude response'),
        ...composer,
      ],
    ];

    for (const lines of fixtures) {
      expect(detectClaudeBashBlocks(lines).blocks).toEqual([]);
      // The conclusive response and composer stay byte-for-byte raw too. In
      // particular, rejecting the outer candidate must not rescan the fake
      // `Bash(...)` header as a second independently hidden block.
      expect(projectClaudeBashLines(lines, { mode: 'hide' }).lines).toBe(lines);
    }
  });

  test('fails open on ambiguous post-result dialog chrome without a later top-level boundary', () => {
    const ambiguous = [
      '● Bash(printf done)',
      '  ⎿  done',
      '╭────────────────────',
      '│ could be wrapped command output or UI',
      '╰────────────────────',
    ];
    expect(detectClaudeBashBlocks(ambiguous).blocks).toEqual([]);
    expect(projectClaudeBashLines(ambiguous, { mode: 'hide' }).lines).toBe(ambiguous);
  });

  test('preserves complete composer and approval UI after Bash output', () => {
    for (const columns of [80, 240]) {
      const rule = `\x1b[38;5;244m${'─'.repeat(columns)}`;
      const composer = [
        '● Bash(printf done)',
        '  ⎿  done',
        rule,
        '❯ ',
        rule,
        '  status',
      ];
      const [composerBlock] = detectClaudeBashBlocks(composer).blocks;
      expect(composerBlock?.sourceRange).toEqual({ startLine: 0, endLine: 2 });
      expect(projectClaudeBashLines(composer, { mode: 'hide' }).lines).toEqual([
        'Bash ซ่อนอยู่ · 2 แถว',
        ...composer.slice(2),
      ]);
    }

    const unpairedRule = [
      '● Bash(printf done)',
      '  ⎿  done',
      `\x1b[38;5;244m${'─'.repeat(80)}`,
      'status without a paired composer',
    ];
    expect(detectClaudeBashBlocks(unpairedRule).blocks).toEqual([]);
    expect(projectClaudeBashLines(unpairedRule, { mode: 'hide' }).lines).toBe(unpairedRule);

    const staleComposerRule = `\x1b[38;5;244m${'─'.repeat(80)}`;
    const staleWidthAfterResize = [
      staleComposerRule,
      '❯ old composer before resize',
      staleComposerRule,
      ...Array.from({ length: 65 }, (_, index) => `archived row ${index}`),
      '● Bash(render-after-resize)',
      `  ⎿  ${'x'.repeat(75)}`,
      '┌────────────────────',
      '│ width is no longer calibrated',
      '└────────────────────',
      '\x1b[38;5;231m●\x1b[39m later response',
    ];
    expect(detectClaudeBashBlocks(staleWidthAfterResize).blocks).toEqual([]);
    expect(projectClaudeBashLines(staleWidthAfterResize, { mode: 'hide' }).lines)
      .toBe(staleWidthAfterResize);

    const approval = [
      '● Bash(printf done)',
      '  ⎿  done',
      '╭─ Do you want to proceed?',
      '│ choose one',
      '❯ 1. Yes',
      '╰────────────────────────',
      '● next',
    ];
    expect(detectClaudeBashBlocks(approval).blocks).toEqual([]);
    expect(projectClaudeBashLines(approval, { mode: 'hide' }).lines).toBe(approval);
  });

  test('accepts a block exactly maxBlockLines rows long when its boundary is next', () => {
    const exactLimit = [
      '● Bash(printf exact)',
      '      continuation)',
      '  ⎿  first',
      '     second',
      '● next',
    ];
    const [block] = detectClaudeBashBlocks(exactLimit, { maxBlockLines: 4 }).blocks;
    expect(block?.sourceRange).toEqual({ startLine: 0, endLine: 4 });

    const tooLong = [...exactLimit];
    tooLong.splice(4, 0, '     third');
    expect(detectClaudeBashBlocks(tooLong, { maxBlockLines: 4 }).blocks).toEqual([]);
  });

  test('does not inspect paint bytes before the maxScanLines corridor', () => {
    const rows = Array.from({ length: 100 }, (_, index) => `archived-${index}`);
    rows[99] = 'current tail';
    const guarded = new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) < 99) {
          throw new Error(`read outside scan corridor: ${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const detection = detectClaudeBashBlocks(guarded, { maxScanLines: 1 });
    expect(detection.scanRange).toEqual({ startLine: 99, endLine: 100 });
    expect(detection.blocks).toEqual([]);
  });

  test('keeps nested Agent Bash and output text containing Bash( as ordinary output', () => {
    const falsePositives = [
      '  Agent(worker)',
      '  ⎿  Bash(nested)',
      '     Running…',
      '     Bash(second nested)',
      '     allowed-tools: Bash(Read,Write)',
      'runBash() in prose',
    ];
    expect(detectClaudeBashBlocks(falsePositives).blocks).toEqual([]);

    const lines = [
      '● Bash(printf nested-text)',
      '  ⎿  Bash(not a header)',
      '     allowed-tools: Bash(Read,Write)',
      '● next',
    ];
    const [block] = detectClaudeBashBlocks(lines).blocks;
    expect(block?.output).toContain('Bash(not a header)');
    expect(block?.sourceRange).toEqual({ startLine: 0, endLine: 3 });
  });

  test('preserves approval/dialog candidates and alternate or unknown screens', () => {
    const approval = [
      active[0]!,
      '      rm important)',
      '╭─ Do you want to proceed?',
      '│ 1. Yes',
    ];
    expect(detectClaudeBashBlocks(approval).blocks).toEqual([]);
    const plainApproval = [
      active[0]!,
      '      rm -rf /tmp/foo)',
      'I want to run: rm -rf /tmp/foo',
      '',
      'Do you want to allow this? [y/N]',
      '❯ 1. Yes',
    ];
    expect(detectClaudeBashBlocks(plainApproval).blocks).toEqual([]);
    expect(detectClaudeBashBlocks(completed, { screenMode: 'alternate' })).toMatchObject({
      enabled: false,
      blocks: [],
    });
    expect(detectClaudeBashBlocks(completed, { screenMode: 'unknown' })).toMatchObject({
      enabled: false,
      blocks: [],
    });
  });

  test('treats a later background completion notice as a boundary, not Bash output', () => {
    const lines = [
      '● Bash(long-task &)',
      '  ⎿  Running in the background (↓ to manage)',
      '',
      '● Background command "long-task" completed (exit code 0)',
    ];
    const [block] = detectClaudeBashBlocks(lines).blocks;
    expect(block?.sourceRange).toEqual({ startLine: 0, endLine: 2 });
    expect(block?.output).toBe('Running in the background (↓ to manage)');

    const projection = projectClaudeBashLines(lines, { mode: 'hide' });
    expect(projection.lines).toEqual([
      'Bash ซ่อนอยู่ · 2 แถว',
      '',
      '● Background command "long-task" completed (exit code 0)',
    ]);
  });

  test('returns bounded previews and stable content fingerprints without cross-output collisions', () => {
    const a = [
      '● Bash(printf abcdef)',
      '  ⎿  first-output',
      '● next',
    ];
    const b = [
      '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf abcdef)',
      '\x1b[38;5;246m  ⎿  \x1b[39mfirst-output',
      '● next',
    ];
    const changed = [
      '● Bash(printf abcdef)',
      '  ⎿  changed-output',
      '● next',
    ];
    const [first] = detectClaudeBashBlocks(a, { maxCommandChars: 7, maxOutputChars: 5 }).blocks;
    const [second] = detectClaudeBashBlocks(b).blocks;
    const [differentOutput] = detectClaudeBashBlocks(changed).blocks;
    expect(first).toMatchObject({
      command: 'printf ',
      output: 'first',
      commandTruncated: true,
      outputTruncated: true,
    });
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first?.fingerprint).not.toBe(differentOutput?.fingerprint);
  });
});

describe('Claude Bash groups', () => {
  test('joins blank-only and direct adjacency, and holds a burst with an active tail', () => {
    const activeBurst = [
      '● Bash(printf first)',
      '  ⎿  first-output',
      '\x1b[0m   ',
      '● Bash(printf second)',
      '  ⎿  second-output',
      active[0]!,
      '      tail)',
    ];
    const detection = detectClaudeBashBlocks(activeBurst);
    expect(detection.blocks).toHaveLength(3);
    const [group] = groupClaudeBashBlocks(activeBurst, detection.blocks);
    expect(group).toMatchObject({
      status: 'active',
      blockCount: 3,
      sourceRange: { startLine: 0, endLine: 7 },
      lineCount: 7,
    });
    expect(group?.command).toContain('[Bash 1/3]');
    expect(group?.command).toContain('[Bash 3/3]');

    const projection = projectClaudeBashGroupedLines(activeBurst, { mode: 'haiku', detection });
    expect(projection.lines).toEqual(['Bash กำลังรัน…']);
    expect(projection.detectedGroups).toHaveLength(1);
    expect(projection.summaryRequests).toEqual([]);
  });

  test('emits one completed group/request after the active tail closes and absorbs separator blanks', () => {
    const finishedBurst = [
      '● Bash(printf first)',
      '  ⎿  first-output',
      '',
      '● Bash(printf second)',
      '  ⎿  second-output',
      '● Bash(printf third)',
      '  ⎿  third-output',
      '\x1b[0m  ',
      '● อธิบายผล',
    ];
    const detection = detectClaudeBashBlocks(finishedBurst);
    const [group] = groupClaudeBashBlocks(finishedBurst, detection.blocks);
    expect(group).toMatchObject({
      status: 'completed',
      blockCount: 3,
      sourceRange: { startLine: 0, endLine: 8 },
      lineCount: 8,
    });
    expect(group?.fingerprint).toMatch(/^claude-bash-group-v1-[0-9a-f]{16}$/);

    const projection = projectClaudeBashGroupedLines(finishedBurst, { mode: 'haiku', detection });
    expect(projection.lines).toEqual(['Bash กำลังสรุป…', '● อธิบายผล']);
    expect(projection.rawToVisualRow).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(projection.summaryRequests).toHaveLength(1);
    expect(projection.summaryRequests[0]).toMatchObject({
      id: group?.id,
      blockCount: 3,
      lineCount: 8,
    });
  });

  test('absorbs proven leading and trailing separator blanks so the divider is the whole gap', () => {
    const separated = [
      '● อธิบายก่อนหน้า',
      '',
      '\x1b[0m \u00a0',
      '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf compact)',
      '  ⎿  compact-output',
      '\x1b[0m   ',
      '\u00a0',
      '● อธิบายถัดไป',
    ];
    const detection = detectClaudeBashBlocks(separated);
    expect(detection.blocks[0]?.sourceRange).toEqual({ startLine: 3, endLine: 5 });

    const [group] = groupClaudeBashBlocks(separated, detection.blocks);
    expect(group).toMatchObject({
      sourceRange: { startLine: 1, endLine: 7 },
      lineCount: 6,
      rawStart: 1,
      rawEndExclusive: 7,
    });

    const projection = projectClaudeBashGroupedLines(separated, { mode: 'hide', detection });
    expect(projection.lines).toEqual([
      '● อธิบายก่อนหน้า',
      'Bash ซ่อนอยู่ · 6 แถว',
      '● อธิบายถัดไป',
    ]);
    expect(projection.rawToVisualRow).toEqual([0, 1, 1, 1, 1, 1, 1, 2]);

    const leadingCapturePadding = separated.slice(1);
    const leadingDetection = detectClaudeBashBlocks(leadingCapturePadding);
    const [leadingGroup] = groupClaudeBashBlocks(leadingCapturePadding, leadingDetection.blocks);
    expect(leadingGroup?.rawStart).toBe(2);

    const acrossRetentionGap = groupClaudeBashBlocks(separated, detection.blocks, {
      barrierLines: [2],
    });
    expect(acrossRetentionGap[0]?.rawStart).toBe(3);
  });

  test('semantic rows and retention barriers split otherwise adjacent groups', () => {
    const semantic = [
      '● Bash(printf first)',
      '  ⎿  first-output',
      '● อธิบายคั่นกลาง',
      '● Bash(printf second)',
      '  ⎿  second-output',
      '● done',
    ];
    const semanticDetection = detectClaudeBashBlocks(semantic);
    expect(groupClaudeBashBlocks(semantic, semanticDetection.blocks)).toHaveLength(2);

    const direct = [
      '● Bash(printf first)',
      '  ⎿  first-output',
      '● Bash(printf second)',
      '  ⎿  second-output',
      '● done',
    ];
    const directDetection = detectClaudeBashBlocks(direct);
    expect(groupClaudeBashBlocks(direct, directDetection.blocks)).toHaveLength(1);
    const split = projectClaudeBashGroupedLines(direct, {
      mode: 'hide',
      detection: directDetection,
      groupingOptions: { barrierLines: [2] },
    });
    expect(split.detectedGroups).toHaveLength(2);
    expect(split.rows.filter((row) => row.kind === 'bash-placeholder')).toHaveLength(2);
  });

  test('bounds merged previews and changes group identity when any member result changes', () => {
    const lines = [
      '● Bash(printf first-command-is-long)',
      '  ⎿  first-output-is-long',
      '● Bash(printf second-command-is-long)',
      '  ⎿  second-output-is-long',
      '● done',
    ];
    const changed = [...lines];
    changed[3] = '  ⎿  changed-second-output';
    const [group] = groupClaudeBashBlocks(lines, detectClaudeBashBlocks(lines).blocks, {
      maxCommandChars: 44,
      maxOutputChars: 40,
    });
    const [changedGroup] = groupClaudeBashBlocks(
      changed,
      detectClaudeBashBlocks(changed).blocks,
      { maxCommandChars: 44, maxOutputChars: 40 },
    );
    expect(group?.command.length).toBeLessThanOrEqual(44);
    expect(group?.output.length).toBeLessThanOrEqual(40);
    expect(group?.command).toContain('[Bash 1/2]');
    expect(group?.command).toContain('[Bash 2/2]');
    expect(group?.command).toContain('printf s');
    expect(group?.output).toContain('second-o');
    expect(group?.commandTruncated).toBe(true);
    expect(group?.outputTruncated).toBe(true);
    expect(group?.fingerprint).not.toBe(changedGroup?.fingerprint);
  });

  test('uses explicit eligibility to distinguish suppressed, pending, and resolved groups', () => {
    const detection = detectClaudeBashBlocks(completed);
    const [group] = groupClaudeBashBlocks(completed, detection.blocks);
    expect(group?.id).toBe(detection.blocks[0]?.id);
    expect(group?.fingerprint).toBe(detection.blocks[0]?.fingerprint);

    const suppressed = projectClaudeBashGroupedLines(completed, {
      mode: 'haiku',
      detection,
      summaryEligibleIds: new Set(),
    });
    expect(suppressed.lines[0]).toBe('hidden bash');
    expect(suppressed.rows[0]?.summaryState).toBe('suppressed');
    expect(suppressed.summaryRequests).toEqual([]);

    const pending = projectClaudeBashGroupedLines(completed, {
      mode: 'haiku',
      detection,
      summaryEligibleIds: new Set([group!.id]),
    });
    expect(pending.rows[0]?.summaryState).toBe('pending');
    expect(pending.summaryRequests).toHaveLength(1);

    const resolved = projectClaudeBashGroupedLines(completed, {
      mode: 'haiku',
      detection,
      summaries: { [group!.id]: 'อ่าน src/a.ts สำเร็จ' },
      summaryEligibleIds: new Set(),
    });
    expect(resolved.rows[0]?.summaryState).toBe('resolved');
    expect(resolved.lines[0]).toBe('Bash · อ่าน src/a.ts สำเร็จ');
    expect(resolved.summaryRequests).toEqual([]);
  });
});

describe('Claude Bash projection', () => {
  test('ThumbmuxPrefs merge-patches the shared host extension key', () => {
    const base: ThumbmuxPrefs = { fontPx: 18, claudeBashMode: 'off' };
    const next = mergePrefs(base, { claudeBashMode: 'haiku' });
    expect(next).toEqual({ fontPx: 18, claudeBashMode: 'haiku' });
    expect(base.claudeBashMode).toBe('off');
  });

  test('off is byte/object parity and exposes identity raw↔visual metadata', () => {
    const raw = [...completed];
    const projection = projectClaudeBashLines(raw, { mode: 'off' });
    expect(projection.rawLines).toBe(raw);
    expect(projection.lines).toBe(raw);
    expect(projection.rawToVisualRow).toEqual([0, 1, 2, 3, 4]);
    expect(projection.visualToRawRange).toEqual([
      { startLine: 0, endLine: 1 },
      { startLine: 1, endLine: 2 },
      { startLine: 2, endLine: 3 },
      { startLine: 3, endLine: 4 },
      { startLine: 4, endLine: 5 },
    ]);
    expect(Object.keys(projection).sort()).toEqual([
      'detectedBlocks',
      'lines',
      'mode',
      'rawLines',
      'rawToVisual',
      'rawToVisualRow',
      'rows',
      'summaryRequests',
      'visualToRaw',
      'visualToRawRange',
    ]);
    expect(Object.keys(projection.rows[0] ?? {}).sort()).toEqual([
      'block',
      'fingerprint',
      'kind',
      'line',
      'rawEndExclusive',
      'rawRange',
      'rawStart',
      'status',
      'visualRow',
    ]);
  });

  test('hide keeps all raw lines separately and replaces each detected span with one row', () => {
    const raw = ['before', ...completed, 'after'];
    const projection = projectClaudeBashLines(raw, { mode: 'hide' });
    expect(projection.rawLines).toBe(raw);
    expect(projection.lines).toEqual([
      'before',
      'Bash ซ่อนอยู่ · 4 แถว',
      completed[4],
      'after',
    ]);
    expect(projection.rows[1]).toMatchObject({
      visualRow: 1,
      kind: 'bash-placeholder',
      rawRange: { startLine: 1, endLine: 5 },
      status: 'completed',
    });
    expect(projection.rawToVisualRow).toEqual([0, 1, 1, 1, 1, 2, 3]);
  });

  test('styled active is one running row and is never emitted to the summarizer', () => {
    const hide = projectClaudeBashLines(active, { mode: 'hide' });
    const haiku = projectClaudeBashLines(active, { mode: 'haiku' });
    expect(hide.lines).toEqual(['Bash กำลังรัน…']);
    expect(haiku.lines).toEqual(['Bash กำลังรัน…']);
    expect(haiku.summaryRequests).toEqual([]);
    expect(haiku.rawToVisualRow).toEqual([0, 0]);
  });

  test('plain active and fail-open screen modes preserve exact rows', () => {
    const plain = ['  Bash(rg Bash src)', '     output'];
    const plainProjection = projectClaudeBashLines(plain, { mode: 'hide' });
    expect(plainProjection.lines).toBe(plain);

    const alternate = projectClaudeBashLines(completed, {
      mode: 'hide',
      detectionOptions: { screenMode: 'alternate' },
    });
    expect(alternate.lines).toBe(completed);
  });

  test('haiku summary arrival changes text only, never row count or mappings', () => {
    const pending = projectClaudeBashLines(completed, { mode: 'haiku' });
    expect(pending.lines[0]).toBe('Bash กำลังสรุป…');
    expect(pending.summaryRequests).toHaveLength(1);
    const fingerprint = pending.summaryRequests[0]!.fingerprint;
    expect(Object.keys(pending.summaryRequests[0] ?? {}).sort()).toEqual([
      'command',
      'commandTruncated',
      'fingerprint',
      'id',
      'lineCount',
      'output',
      'outputTruncated',
    ]);

    const resolved = projectClaudeBashLines(completed, {
      mode: 'haiku',
      summaries: {
        [fingerprint]: '\x1b[31mเปิด src/a.ts\x1b[0m\nแล้วอ่าน 80 แถว\u202e',
      },
    });
    expect(resolved.lines[0]).toBe('Bash · เปิด src/a.ts แล้วอ่าน 80 แถว');
    expect(resolved.summaryRequests).toEqual([]);
    expect(resolved.lines).toHaveLength(pending.lines.length);
    expect(resolved.rawToVisualRow).toEqual(pending.rawToVisualRow);
    expect(resolved.visualToRawRange).toEqual(pending.visualToRawRange);
  });

  test('deduplicates exact repeated summaries but keeps different output IDs separate', () => {
    const twice = [
      '● Bash(printf ok)',
      '  ⎿  one',
      '● Bash(printf ok)',
      '  ⎿  one',
      '● next',
    ];
    const projection = projectClaudeBashLines(twice, { mode: 'haiku' });
    expect(projection.lines).toHaveLength(3);
    expect(projection.summaryRequests).toHaveLength(1);
    expect(projection.rows[0]?.fingerprint).toBe(projection.rows[1]?.fingerprint);

    const differentOutput = [...twice];
    differentOutput[3] = '  ⎿  two';
    const distinct = projectClaudeBashLines(differentOutput, { mode: 'haiku' });
    expect(distinct.summaryRequests).toHaveLength(2);
    expect(distinct.rows[0]?.fingerprint).not.toBe(distinct.rows[1]?.fingerprint);
  });
});
