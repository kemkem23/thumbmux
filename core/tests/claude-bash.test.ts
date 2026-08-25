import { describe, expect, test } from 'bun:test';

import {
  detectClaudeBashBlocks,
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
      expect(block?.output).toContain(continuation.at(-1));

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
      { raw: '❯ shell prompt-shaped output', visible: '❯ shell prompt-shaped output' },
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
