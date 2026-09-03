import { describe, expect, test } from 'bun:test';

import { detectCodexToolBlocks } from '../src/codex-tools';
import { projectToolLines } from '../src/tool-projection';

const runGroup = '\x1b[1m\x1b[38;5;2m•\x1b[0m \x1b[1mRan 2 commands'
  + '\x1b[0;2m · ctrl + t to view transcript\x1b[0m';

const successfulRun = '\x1b[1m\x1b[38;5;2m•\x1b[0m \x1b[1mRan\x1b[0m '
  + '\x1b[38;2;137;180;250mbun\x1b[38;2;205;214;244m test\x1b[39m';

const failedRun = '\x1b[1m\x1b[38;5;1m•\x1b[0m \x1b[1mRan\x1b[0m '
  + '\x1b[38;2;137;180;250mbun\x1b[38;2;205;214;244m test\x1b[39m';

const waited = '\x1b[0;1m• Waited for background terminal\x1b[0;2m'
  + ' · .agents/skills/\x1b[0m';

const ownerMobileWaited = '\x1b[0;1m• Waited for background terminal\x1b[0;2m'
  + ' · ./.agents/skills/\x1b[0m';
const ownerMobilePrompt = [
  "\x1b[2mexec/exec.sh codex sol 'Campaign 1\x1b[0m",
  '\x1b[2mVendor Chat, exactly one new read-only G4\x1b[0m',
  '\x1b[2mblocker-extraction/admission lane under authorized\x1b[0m',
  '\x1b[2mlocal fallback from terminal RELAY_UNAVAILABLE/FAILED.\x1b[0m',
];

const waiting = '\x1b[2m• \x1b[0;1mWaiting for agents\x1b[0m';
const finished = '\x1b[2m• \x1b[0;1mFinished waiting\x1b[0m';
const noAgents = '\x1b[2m  └ \x1b[0mNo agents completed yet';
const interacted = '\x1b[2m• \x1b[0;1mInteracted with \x1b[0m'
  + '\x1b[38;5;6m`/root/final_static_review`\x1b[39m';
const started = '\x1b[2m• \x1b[0;1mStarted \x1b[0m'
  + '\x1b[38;5;6m`/root/detector_worker`\x1b[39m';
const completed = '\x1b[2m• \x1b[0;1mCompleted \x1b[0m'
  + '\x1b[38;5;6m`/root/detector_worker`\x1b[39m';
const backgroundInteraction = '\x1b[2m↳ \x1b[0;1mInteracted with background terminal'
  + '\x1b[0;2m · bun run dev\x1b[0m';
const viewedImage = '\x1b[2m• \x1b[0;1mViewed Image\x1b[0m';
const imagePath = '\x1b[2m  └ /tmp/proof/mobile-320x700.png\x1b[0m';
const edited = '\x1b[2m• \x1b[0;1mEdited\x1b[0m 2 files ('
  + '\x1b[38;5;2m+102\x1b[39m \x1b[38;5;1m-32\x1b[39m)';

describe('Codex completed tool detector', () => {
  test('recognises the exact successful aggregate signature but not visible text alone', () => {
    const rawLines = ['', runGroup, '', 'Ran 2 commands', '', 'assistant prose'];
    const detection = detectCodexToolBlocks(rawLines);

    expect(detection.blocks).toHaveLength(1);
    expect(detection.blocks[0]).toMatchObject({
      provider: 'codex',
      kind: 'run-group',
      outcome: 'succeeded',
      sourceRange: { startLine: 1, endLine: 2 },
      proofRange: { startLine: 1, endLine: 2 },
      collapseRanges: [{ startLine: 1, endLine: 2 }],
      protectedRanges: [],
      label: 'Codex commands',
    });
    expect(detection.blocks[0]?.fingerprint).toMatch(/^tool-v1-[0-9a-f]{16}$/);
  });

  test('collapses a sealed green Ran block and preserves red failures and approvals', () => {
    const successful = [
      '',
      successfulRun,
      '\x1b[2m  └ bun test v1.3.11\x1b[0m',
      '\x1b[2m    8 passed (17.3s)\x1b[0m',
      '',
    ];
    const successDetection = detectCodexToolBlocks(successful);
    expect(successDetection.blocks[0]).toMatchObject({
      kind: 'run',
      outcome: 'succeeded',
      sourceRange: { startLine: 1, endLine: 4 },
      proofRange: { startLine: 1, endLine: 5 },
    });
    expect(projectToolLines(successful, { blocks: successDetection.blocks }).lines).toEqual([
      '',
      'Codex command ซ่อนอยู่ · 3 แถว',
      '',
    ]);

    const failed = [
      '',
      failedRun,
      '\x1b[2m  └ error: tests failed\x1b[0m',
      '',
    ];
    expect(detectCodexToolBlocks(failed).blocks).toEqual([]);

    const approvalInsideCandidate = [
      '',
      successfulRun,
      '\x1b[2m  └ starting privileged action\x1b[0m',
      'Do you want to allow this command?',
      '',
    ];
    expect(detectCodexToolBlocks(approvalInsideCandidate).blocks).toEqual([]);
  });

  test('keeps a green Ran identity stable when its RGB command header soft-wraps', () => {
    const runPrefix = '\x1b[1m\x1b[38;5;2m•\x1b[0m \x1b[1mRan\x1b[0m '
      + '\x1b[38;2;137;180;250mvery-long-';
    const wide = [
      '',
      `${runPrefix}command\x1b[39m`,
      '\x1b[2m  └ completed output\x1b[0m',
      '',
    ];
    const carried = [
      '',
      runPrefix,
      'command\x1b[39m',
      '\x1b[2m  └ completed output\x1b[0m',
      '',
    ];
    const repainted = [
      '',
      runPrefix,
      '\x1b[38;2;137;180;250mcommand\x1b[39m',
      '\x1b[2m  └ completed output\x1b[0m',
      '',
    ];
    const wideBlock = detectCodexToolBlocks(wide).blocks[0];
    const carriedBlock = detectCodexToolBlocks(carried).blocks[0];
    const repaintedBlock = detectCodexToolBlocks(repainted).blocks[0];

    expect(wideBlock).toMatchObject({ kind: 'run', sourceRange: { startLine: 1, endLine: 3 } });
    expect(carriedBlock).toMatchObject({ kind: 'run', sourceRange: { startLine: 1, endLine: 4 } });
    expect(repaintedBlock).toMatchObject({ kind: 'run', sourceRange: { startLine: 1, endLine: 4 } });
    expect(carriedBlock?.fingerprint).toBe(wideBlock?.fingerprint);
    expect(repaintedBlock?.fingerprint).toBe(wideBlock?.fingerprint);
  });

  test('does not bridge a completed Ran header through unrelated coloured prose', () => {
    const cyanAssistant = '\x1b[38;5;6mข้อความอธิบายของ assistant\x1b[39m';
    const laterDimRow = '\x1b[2m  secondary text that is not Run output\x1b[0m';
    expect(detectCodexToolBlocks([
      '',
      successfulRun,
      cyanAssistant,
      laterDimRow,
      '',
    ]).blocks).toEqual([]);

    const activeCommandColor = '\x1b[1m\x1b[38;5;2m•\x1b[0m \x1b[1mRan\x1b[0m '
      + '\x1b[38;2;137;180;250mvery-long-command-';
    expect(detectCodexToolBlocks([
      '',
      activeCommandColor,
      cyanAssistant,
      laterDimRow,
      '',
    ]).blocks).toEqual([]);
  });

  test('keeps a completed Waited command together across narrow column-zero wraps', () => {
    const narrow = [
      '',
      waited,
      '\x1b[2mexec/exec.sh grok grok-4.6 "long prompt\x1b[0m',
      '\x1b[2mcontinued-at-column-zero"\x1b[0m',
      '',
    ];
    const [block] = detectCodexToolBlocks(narrow).blocks;
    expect(block).toMatchObject({
      kind: 'background-wait',
      outcome: 'completed',
      sourceRange: { startLine: 1, endLine: 4 },
      proofRange: { startLine: 1, endLine: 5 },
      collapseRanges: [{ startLine: 1, endLine: 4 }],
    });

    const rewrapped = [
      '',
      '\x1b[1m• Waited for background terminal\x1b[0;2m'
        + ' · .agents/skills/\x1b[0m',
      '\x1b[2mexec/exec.sh grok grok-4.6 "long prompt continued-at-column-zero"\x1b[0m',
      '',
    ];
    expect(detectCodexToolBlocks(rewrapped).blocks[0]?.fingerprint).toBe(block?.fingerprint);

    // capture-pane -e can carry faint state across a physical wrap instead of
    // repeating SGR at column zero. The final reset may arrive on that row.
    const inheritedPaint = [
      '',
      '\x1b[0;1m• Waited for background terminal\x1b[0;2m · very-long-',
      'command-token-that-wraps\x1b[0m',
      '\x1b[2mcontinued after an explicit repaint\x1b[0m',
      '',
    ];
    expect(detectCodexToolBlocks(inheritedPaint).blocks[0]).toMatchObject({
      kind: 'background-wait',
      sourceRange: { startLine: 1, endLine: 4 },
    });
  });

  test('hides the owner mobile Waited fixture when its seal is SGR/NBSP-only', () => {
    const rawLines = [
      '',
      ownerMobileWaited,
      ...ownerMobilePrompt,
      '\x1b[0m \u00a0\x1b[39m',
      'assistant prose',
    ];
    const detection = detectCodexToolBlocks(rawLines);

    expect(detection.blocks).toHaveLength(1);
    expect(detection.blocks[0]).toMatchObject({
      kind: 'background-wait',
      outcome: 'completed',
      sourceRange: { startLine: 1, endLine: 6 },
      proofRange: { startLine: 1, endLine: 7 },
    });
    expect(projectToolLines(rawLines, { blocks: detection.blocks }).lines).toEqual([
      '',
      'Codex background wait ซ่อนอยู่ · 5 แถว',
      '\x1b[0m \u00a0\x1b[39m',
      'assistant prose',
    ]);
  });

  test('finds a sealed Waited block directly after a self-completing Ran group', () => {
    const rawLines = ['', runGroup, ownerMobileWaited, ''];
    expect(detectCodexToolBlocks(rawLines).blocks.map((block) => ({
      kind: block.kind,
      sourceRange: block.sourceRange,
    }))).toEqual([
      { kind: 'run-group', sourceRange: { startLine: 1, endLine: 2 } },
      { kind: 'background-wait', sourceRange: { startLine: 2, endLine: 3 } },
    ]);
  });

  test('requires Finished waiting before collapsing the paired agent wait corridor', () => {
    expect(detectCodexToolBlocks(['', waiting, '']).blocks).toEqual([]);

    const complete = ['', waiting, '', finished, noAgents, '', 'assistant prose'];
    const [block] = detectCodexToolBlocks(complete).blocks;
    expect(block).toMatchObject({
      kind: 'agent-wait',
      sourceRange: { startLine: 1, endLine: 5 },
      proofRange: { startLine: 1, endLine: 6 },
      collapseRanges: [{ startLine: 1, endLine: 5 }],
    });
    expect(projectToolLines(complete, { blocks: block ? [block] : [] }).lines).toEqual([
      '',
      'Codex agent wait ซ่อนอยู่ · 4 แถว',
      '',
      'assistant prose',
    ]);

    const standalone = ['', finished, noAgents, '', 'tail'];
    expect(detectCodexToolBlocks(standalone).blocks[0]).toMatchObject({
      kind: 'agent-wait',
      sourceRange: { startLine: 1, endLine: 3 },
      proofRange: { startLine: 1, endLine: 4 },
    });
  });

  test('detects sealed agent lifecycle/interactions and Viewed Image details', () => {
    const rawLines = [
      '',
      interacted,
      '',
      started,
      '',
      completed,
      '',
      backgroundInteraction,
      '\x1b[2m47800\x1b[0m',
      '',
      viewedImage,
      imagePath,
      '',
    ];
    const detection = detectCodexToolBlocks(rawLines);
    expect(detection.blocks.map((block) => block.kind)).toEqual([
      'agent-interaction',
      'agent-start',
      'agent-complete',
      'background-interaction',
      'view-image',
    ]);
    expect(detection.blocks.map((block) => block.sourceRange)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
      { startLine: 5, endLine: 6 },
      { startLine: 7, endLine: 9 },
      { startLine: 10, endLine: 12 },
    ]);

    expect(detectCodexToolBlocks([
      '',
      'systemd: Started cortex-orchestrator.service successfully',
      '',
      'Completed 12 migration steps',
      '',
    ]).blocks).toEqual([]);
  });

  test('preserves an Edited header and collapses only the sealed diff body', () => {
    const rawLines = [
      '',
      edited,
      '    \x1b[2m1788 -    opacity: 0.22;\x1b[0m',
      '    \x1b[2m1788 +    opacity: 0.46;\x1b[0m',
      '',
      'assistant prose',
    ];
    const detection = detectCodexToolBlocks(rawLines);
    expect(detection.blocks[0]).toMatchObject({
      kind: 'edit',
      sourceRange: { startLine: 1, endLine: 4 },
      collapseRanges: [{ startLine: 2, endLine: 4 }],
      protectedRanges: [{ startLine: 1, endLine: 2 }],
    });

    const projection = projectToolLines(rawLines, { blocks: detection.blocks });
    expect(projection.lines[1]).toBe(edited);
    expect(projection.lines[2]).toBe('Codex edit details ซ่อนอยู่ · 2 แถว');
    expect(projection.lines.at(-1)).toBe('assistant prose');
  });

  test('never hides Working state, background status, prompts, composers, or ghost text', () => {
    const protectedLines = [
      '\x1b[2m◦ Working (12s · esc to interrupt)\x1b[0m',
      '3 background terminals running · /ps to view',
      '› latest submitted prompt',
      '» typed composer text',
      '› \x1b[1m• Waited for background terminal\x1b[0m',
      '› ghost suggestion after the composer',
    ];
    const rawLines = protectedLines.flatMap((line) => ['', line]);
    rawLines.push('');
    expect(detectCodexToolBlocks(rawLines).blocks).toEqual([]);

    const successfulWithPrompt = [
      '',
      successfulRun,
      '\x1b[2m  └ output before prompt\x1b[0m',
      '› prompt must remain',
      '',
    ];
    expect(detectCodexToolBlocks(successfulWithPrompt).blocks).toEqual([]);

    const successfulWithWrappedWorking = [
      '',
      successfulRun,
      '\x1b[2m  └ completed output\x1b[0m',
      '\x1b[2m◦ Working (12s · esc to\x1b[0m',
      '\x1b[2m  interrupt)\x1b[0m',
      '',
    ];
    expect(detectCodexToolBlocks(successfulWithWrappedWorking).blocks).toEqual([]);

    const successfulWithWrappedBackgroundHud = [
      '',
      successfulRun,
      '\x1b[2m  └ completed output\x1b[0m',
      '\x1b[2m3 background terminals\x1b[0m',
      '\x1b[2m  running · /ps to view\x1b[0m',
      '',
    ];
    expect(detectCodexToolBlocks(successfulWithWrappedBackgroundHud).blocks).toEqual([]);

    const successfulWithAssistantProse = [
      '',
      successfulRun,
      '\x1b[2m  └ completed output\x1b[0m',
      'ข้อความอธิบายของ assistant ต้องอยู่บนจอ',
      '',
    ];
    expect(detectCodexToolBlocks(successfulWithAssistantProse).blocks).toEqual([]);
  });

  test('keeps occurrence ids stable across prepend and eviction of duplicate content', () => {
    const original = ['', runGroup, '', runGroup, ''];
    const initial = detectCodexToolBlocks(original, { identityLineOffset: 100 });
    expect(initial.blocks.map((block) => block.id)).toEqual([
      `${initial.blocks[0]?.fingerprint}:row-101`,
      `${initial.blocks[1]?.fingerprint}:row-103`,
    ]);

    const prepended = ['older row', '', ...original];
    const afterPrepend = detectCodexToolBlocks(prepended, { identityLineOffset: 98 });
    expect(afterPrepend.blocks.map((block) => block.id)).toEqual(
      initial.blocks.map((block) => block.id),
    );

    const afterEviction = detectCodexToolBlocks(original.slice(2), { identityLineOffset: 102 });
    expect(afterEviction.blocks[0]?.id).toBe(initial.blocks[1]?.id);
    const beforeKey = projectToolLines(original, { blocks: initial.blocks }).rows
      .find((row) => row.rawStart === 3)?.placeholderKey;
    const afterKey = projectToolLines(original.slice(2), { blocks: afterEviction.blocks }).rows
      .find((row) => row.kind === 'tool-placeholder')?.placeholderKey;
    expect(afterKey).toBe(beforeKey);
  });

  test('fails open for malformed ANSI, unknown leading edges, and soft-wrap corridors', () => {
    expect(detectCodexToolBlocks([runGroup, '']).blocks).toEqual([]);
    expect(detectCodexToolBlocks([runGroup, ''], { leadingEdgeSealed: true }).blocks)
      .toHaveLength(1);

    const softWrapped = ['assistant row fills the previous pane width', waited, ''];
    expect(detectCodexToolBlocks(softWrapped, { leadingEdgeSealed: true }).blocks).toEqual([]);

    const malformed = ['', `${waited}\x1b[`, ''];
    expect(detectCodexToolBlocks(malformed).blocks).toEqual([]);
    expect(detectCodexToolBlocks(['', runGroup, ''], { screenMode: 'alternate' })).toMatchObject({
      enabled: false,
      blocks: [],
    });
  });

  test('honours scan, block, and retained-block caps without partial hiding', () => {
    const first = runGroup.replace('2 commands', '3 commands');
    const second = runGroup.replace('2 commands', '4 commands');
    const third = runGroup.replace('2 commands', '5 commands');
    const many = ['', first, '', second, '', third, ''];
    const capped = detectCodexToolBlocks(many, { maxBlocks: 2 });
    expect(capped.blocks).toHaveLength(2);
    expect(capped.blocks.map((block) => block.sourceRange.startLine)).toEqual([3, 5]);

    expect(detectCodexToolBlocks(many, { maxScanLines: 1 }).blocks).toEqual([]);
    const tooLong = [
      '',
      waited,
      '\x1b[2mcontinuation one\x1b[0m',
      '\x1b[2mcontinuation two\x1b[0m',
      '',
    ];
    expect(detectCodexToolBlocks(tooLong, { maxBlockLines: 2 }).blocks).toEqual([]);
    expect(detectCodexToolBlocks(tooLong, { maxBlockChars: waited.length + 10 }).blocks)
      .toEqual([]);
  });
});
