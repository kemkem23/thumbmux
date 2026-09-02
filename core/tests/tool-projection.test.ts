import { describe, expect, test } from 'bun:test';

import {
  coalesceAdjacentToolProjection,
  projectToolLines,
  reconcileToolBlockIds,
  stableToolFingerprint,
  validateToolCollapseBlocks,
  type ToolCollapseBlock,
  type ToolLineRange,
} from '../src/tool-projection';

const range = (startLine: number, endLine: number): ToolLineRange => ({ startLine, endLine });

function block(
  sourceRange: ToolLineRange,
  collapseRanges: readonly ToolLineRange[],
  protectedRanges: readonly ToolLineRange[] = [],
  proofRange: ToolLineRange = sourceRange,
  fingerprint = 'tool-v1-fixture',
): ToolCollapseBlock {
  return {
    id: fingerprint,
    provider: 'codex',
    kind: protectedRanges.length > 0 ? 'edit' : 'run',
    outcome: 'succeeded',
    sourceRange,
    proofRange,
    collapseRanges,
    protectedRanges,
    fingerprint,
    label: 'Codex tool',
  };
}

type GroupedToolProjection = ReturnType<typeof coalesceAdjacentToolProjection>;
type ToolPlaceholderGroup = NonNullable<
  GroupedToolProjection['rows'][number]['placeholderGroup']
>;

function placeholderGroups(projection: GroupedToolProjection): ToolPlaceholderGroup[] {
  return projection.rows.flatMap((row) => (
    row.placeholderGroup ? [row.placeholderGroup] : []
  ));
}

describe('provider-neutral tool projection', () => {
  test('collapses a proven range and maintains exact raw/visual mappings', () => {
    const rawLines = ['', 'ran header', 'output', '', 'assistant prose'];
    const projection = projectToolLines(rawLines, {
      blocks: [block(range(1, 3), [range(1, 3)], [], range(1, 4))],
    });

    expect(projection.lines).toEqual([
      '',
      'Codex tool ซ่อนอยู่ · 2 แถว',
      '',
      'assistant prose',
    ]);
    expect(projection.visualToRaw).toEqual([
      range(0, 1),
      range(1, 3),
      range(3, 4),
      range(4, 5),
    ]);
    expect(projection.rawToVisual).toEqual([0, 1, 1, 2, 3]);
    expect(projection.rows[1]).toMatchObject({
      kind: 'tool-placeholder',
      rawStart: 1,
      rawEndExclusive: 3,
      fingerprint: 'tool-v1-fixture',
      placeholderKey: 'tool-placeholder:codex:tool-v1-fixture:part-0',
    });
    expect(projection.rows.every((row) => !('blockCount' in row))).toBe(true);
    expect(projection.rows.every((row) => !('placeholderGroup' in row))).toBe(true);
    expect(projection.hiddenLineCount).toBe(2);
  });

  test('keeps an Edited header raw while collapsing only its declared body', () => {
    const rawLines = ['', '• Edited a.ts (+1 -1)', '  1 - old', '  1 + new', '', 'tail'];
    const edit = block(
      range(1, 4),
      [range(2, 4)],
      [range(1, 2)],
      range(1, 5),
      'tool-v1-edit',
    );
    const projection = projectToolLines(rawLines, {
      blocks: [edit],
      placeholder: ({ lineCount }) => `  … ${lineCount} diff rows hidden`,
    });

    expect(projection.lines).toEqual([
      '',
      '• Edited a.ts (+1 -1)',
      '  … 2 diff rows hidden',
      '',
      'tail',
    ]);
    expect(projection.rawToVisual).toEqual([0, 1, 2, 2, 3, 4]);
    expect(projection.rows[1]?.kind).toBe('raw');
    expect(projection.rows[2]?.placeholderKey).toBe(
      'tool-placeholder:codex:tool-v1-edit:part-0',
    );
  });

  test('supports multiple collapse islands only when protected rows cover every gap', () => {
    const rawLines = ['header', 'body one', 'important summary', 'body two'];
    const split = block(
      range(0, 4),
      [range(0, 2), range(3, 4)],
      [range(2, 3)],
      range(0, 4),
      'tool-v1-split',
    );
    const projection = projectToolLines(rawLines, { blocks: [split] });

    expect(projection.lines).toEqual([
      'Codex tool ซ่อนอยู่ · 2 แถว',
      'important summary',
      'Codex tool ซ่อนอยู่ · 1 แถว',
    ]);
    expect(projection.rawToVisual).toEqual([0, 0, 1, 2]);
    expect(projection.rows.map((row) => row.placeholderKey)).toEqual([
      'tool-placeholder:codex:tool-v1-split:part-0',
      null,
      'tool-placeholder:codex:tool-v1-split:part-1',
    ]);
  });

  test('coalesces equal-provider placeholders through complete ANSI/NBSP blank rows', () => {
    const rawLines = [
      'before',
      'tool one',
      '\x1b[0m \u00a0\t',
      'tool two',
      'after',
    ];
    const first = block(range(1, 2), [range(1, 2)], [], range(1, 3), 'first');
    const second = block(range(3, 4), [range(3, 4)], [], range(3, 4), 'second');
    const projected = projectToolLines(rawLines, {
      blocks: [first, second],
      placeholder: () => 'hidden tools',
    });
    const coalesced = coalesceAdjacentToolProjection(projected);

    expect(coalesced.lines).toEqual(['before', 'hidden tools', 'after']);
    expect(coalesced.visualToRawRange).toEqual([
      range(0, 1),
      range(1, 4),
      range(4, 5),
    ]);
    expect(coalesced.rawToVisualRow).toEqual([0, 1, 1, 1, 2]);
    expect(coalesced.hiddenLineCount).toBe(3);
    expect(coalesced.projectedBlocks).toBe(projected.projectedBlocks);
    expect(coalesced.rejectedBlocks).toBe(projected.rejectedBlocks);
    expect(coalesced.rows[1]).toMatchObject({
      kind: 'tool-placeholder',
      rawStart: 1,
      rawEndExclusive: 4,
      block: null,
      fingerprint: null,
      blockCount: 2,
      placeholderGroup: {
        provider: 'codex',
        line: 'hidden tools',
        rawRange: range(1, 4),
        memberPlaceholderKeys: [
          'tool-placeholder:codex:first:part-0',
          'tool-placeholder:codex:second:part-0',
        ],
        blockCount: 2,
      },
    });

    const directLines = ['tool one', 'tool two'];
    const direct = coalesceAdjacentToolProjection(projectToolLines(directLines, {
      blocks: [
        block(range(0, 1), [range(0, 1)], [], range(0, 1), 'direct-first'),
        block(range(1, 2), [range(1, 2)], [], range(1, 2), 'direct-second'),
      ],
      placeholder: () => 'hidden tools',
    }));
    expect(direct.lines).toEqual(['hidden tools']);
    expect(direct.visualToRawRange).toEqual([range(0, 2)]);
    expect(direct.rows[0]?.blockCount).toBe(2);
  });

  test('does not coalesce across barriers, protected/rejected rows, or malformed ANSI', () => {
    const rawLines = ['tool one', '\x1b[0m \u00a0', 'tool two'];
    const first = block(range(0, 1), [range(0, 1)], [], range(0, 1), 'first');
    const second = block(range(2, 3), [range(2, 3)], [], range(2, 3), 'second');
    const projected = projectToolLines(rawLines, {
      blocks: [first, second],
      placeholder: () => 'hidden tools',
    });
    const barrierSplit = coalesceAdjacentToolProjection(projected, { barrierLines: [2] });
    expect(barrierSplit.rows.filter((row) => row.kind === 'tool-placeholder')).toHaveLength(2);
    expect(barrierSplit.lines).toEqual(['hidden tools', '\x1b[0m \u00a0', 'hidden tools']);

    const protectedBlock = block(
      range(0, 3),
      [range(0, 1), range(2, 3)],
      [range(1, 2)],
      range(0, 3),
      'protected-split',
    );
    const protectedProjection = coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks: [protectedBlock],
      placeholder: () => 'hidden tools',
    }));
    expect(protectedProjection.rows.filter((row) => row.kind === 'tool-placeholder'))
      .toHaveLength(2);
    expect(protectedProjection.rows[1]?.kind).toBe('raw');

    const rejectedGap = {
      ...block(range(1, 2), [range(1, 2)], [], range(1, 2), 'rejected-gap'),
      label: '',
    };
    const rejectedProjection = coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks: [first, rejectedGap, second],
      placeholder: () => 'hidden tools',
    }));
    expect(rejectedProjection.rejectedBlocks[0]?.reason).toBe('invalid-identity');
    expect(rejectedProjection.rows.filter((row) => row.kind === 'tool-placeholder'))
      .toHaveLength(2);

    for (const unsafeControl of ['\x1b[', '\x1b[2J', '\x1bD']) {
      const unsafeLines = ['tool one', unsafeControl, 'tool two'];
      const unsafeProjection = coalesceAdjacentToolProjection(projectToolLines(unsafeLines, {
        blocks: [first, second],
        placeholder: () => 'hidden tools',
      }));
      expect(unsafeProjection.rows.filter((row) => row.kind === 'tool-placeholder'))
        .toHaveLength(2);
      expect(unsafeProjection.lines[1]).toBe(unsafeControl);
    }

    const visibleLines = ['tool one', '› submitted prompt stays visible', 'tool two'];
    const visibleProjection = coalesceAdjacentToolProjection(projectToolLines(visibleLines, {
      blocks: [first, second],
      placeholder: () => 'hidden tools',
    }));
    expect(visibleProjection.rows.filter((row) => row.kind === 'tool-placeholder'))
      .toHaveLength(2);
    expect(visibleProjection.lines[1]).toBe('› submitted prompt stays visible');
  });

  test('does not merge different providers or unequal custom placeholder text', () => {
    const rawLines = ['tool one', '', 'tool two'];
    const first = block(range(0, 1), [range(0, 1)], [], range(0, 1), 'first');
    const second = block(range(2, 3), [range(2, 3)], [], range(2, 3), 'second');
    const crossProvider = {
      ...second,
      provider: 'claude' as const,
    };
    const providerProjection = coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks: [first, crossProvider],
      placeholder: () => 'hidden tools',
    }));
    expect(providerProjection.rows.filter((row) => row.kind === 'tool-placeholder'))
      .toHaveLength(2);

    const customProjection = coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks: [first, second],
      placeholder: ({ block: source }) => `hidden ${source.id}`,
    }));
    expect(customProjection.lines).toEqual(['hidden first', '', 'hidden second']);
    expect(customProjection.rows.filter((row) => row.kind === 'tool-placeholder'))
      .toHaveLength(2);
  });

  test('carries group identity through append and front-drop, but not replacement', () => {
    const occurrence = (id: string, startLine: number): ToolCollapseBlock => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        id,
      ),
      id,
    });
    const grouped = (
      rawLines: readonly string[],
      blocks: readonly ToolCollapseBlock[],
      previousGroups: readonly ToolPlaceholderGroup[] = [],
    ) => coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks,
      placeholder: () => 'hidden tools',
    }), { previousGroups });

    const initial = grouped(
      ['A', '', 'B'],
      [occurrence('A', 0), occurrence('B', 2)],
    );
    const initialGroup = placeholderGroups(initial)[0];
    expect(initialGroup).toMatchObject({ blockCount: 2 });
    expect(initialGroup?.placeholderKey).toBe('tool-placeholder:codex:A:part-0');

    const appended = grouped(
      ['A', '', 'B', '', 'C'],
      [occurrence('A', 0), occurrence('B', 2), occurrence('C', 4)],
      placeholderGroups(initial),
    );
    const appendedGroup = placeholderGroups(appended)[0];
    expect(appendedGroup).toMatchObject({ blockCount: 3 });
    expect(appendedGroup?.placeholderKey).toBe(initialGroup?.placeholderKey);

    const frontDropped = grouped(
      ['B', '', 'C'],
      [occurrence('B', 0), occurrence('C', 2)],
      placeholderGroups(appended),
    );
    const frontDroppedGroup = placeholderGroups(frontDropped)[0];
    expect(frontDroppedGroup?.memberPlaceholderKeys).toEqual([
      'tool-placeholder:codex:B:part-0',
      'tool-placeholder:codex:C:part-0',
    ]);
    expect(frontDroppedGroup?.placeholderKey).toBe(initialGroup?.placeholderKey);
    expect(frontDropped.rows[0]?.placeholderKey).toBe(initialGroup?.placeholderKey);

    const replaced = grouped(
      ['D', '', 'E'],
      [occurrence('D', 0), occurrence('E', 2)],
      placeholderGroups(frontDropped),
    );
    const replacedGroup = placeholderGroups(replaced)[0];
    expect(replacedGroup?.placeholderKey).toBe('tool-placeholder:codex:D:part-0');
    expect(replacedGroup?.placeholderKey).not.toBe(initialGroup?.placeholderKey);

    const collidingReplacement = grouped(
      ['A'],
      [occurrence('A', 0)],
      placeholderGroups(frontDropped),
    );
    const collidingReplacementKey = placeholderGroups(collidingReplacement)[0]?.placeholderKey;
    expect(collidingReplacementKey).not.toBe(initialGroup?.placeholderKey);
    expect(collidingReplacementKey).toStartWith('tool-placeholder:codex:A:part-0:group-');
  });

  test('assigns one old key on split and deterministically restores it on merge', () => {
    const occurrence = (id: string, startLine: number): ToolCollapseBlock => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        id,
      ),
      id,
    });
    const grouped = (
      rawLines: readonly string[],
      blocks: readonly ToolCollapseBlock[],
      previousGroups: readonly ToolPlaceholderGroup[] = [],
    ) => coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks,
      placeholder: () => 'hidden tools',
    }), { previousGroups });

    const initial = grouped(
      ['A', '', 'B', '', 'C'],
      [occurrence('A', 0), occurrence('B', 2), occurrence('C', 4)],
    );
    const initialKey = placeholderGroups(initial)[0]?.placeholderKey;

    const split = grouped(
      ['A', '', 'B', '', '› submitted prompt stays visible', '', 'C'],
      [occurrence('A', 0), occurrence('B', 2), occurrence('C', 6)],
      placeholderGroups(initial),
    );
    const splitGroups = placeholderGroups(split);
    expect(splitGroups).toHaveLength(2);
    expect(splitGroups[0]?.placeholderKey).toBe(initialKey);
    expect(splitGroups[1]?.placeholderKey).toBe('tool-placeholder:codex:C:part-0');
    expect(split.lines).toContain('› submitted prompt stays visible');

    const merged = grouped(
      ['A', '', 'B', '', 'C'],
      [occurrence('A', 0), occurrence('B', 2), occurrence('C', 4)],
      splitGroups,
    );
    expect(placeholderGroups(merged)).toHaveLength(1);
    expect(placeholderGroups(merged)[0]?.placeholderKey).toBe(initialKey);
  });

  test('maximizes carried keys across simultaneous adjacent split and merge', () => {
    const occurrence = (id: string, startLine: number): ToolCollapseBlock => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        id,
      ),
      id,
    });
    const grouped = (
      rawLines: readonly string[],
      ids: readonly string[],
      barrierLines: readonly number[],
      previousGroups: readonly ToolPlaceholderGroup[] = [],
    ) => coalesceAdjacentToolProjection(projectToolLines(rawLines, {
      blocks: ids.map((id, index) => occurrence(id, index * 2)),
      placeholder: () => 'hidden tools',
    }), { barrierLines, previousGroups });

    const previous = grouped(
      ['A', '', 'B', '', 'C', '', 'D'],
      ['A', 'B', 'C', 'D'],
      [4],
    );
    const previousGroups = placeholderGroups(previous);
    expect(previousGroups.map(({ memberPlaceholderKeys }) => memberPlaceholderKeys)).toEqual([
      ['tool-placeholder:codex:A:part-0', 'tool-placeholder:codex:B:part-0'],
      ['tool-placeholder:codex:C:part-0', 'tool-placeholder:codex:D:part-0'],
    ]);

    const shifted = grouped(
      ['B', '', 'C', '', 'D'],
      ['B', 'C', 'D'],
      [4],
      previousGroups,
    );
    expect(placeholderGroups(shifted).map(({ placeholderKey }) => placeholderKey)).toEqual([
      previousGroups[0]?.placeholderKey,
      previousGroups[1]?.placeholderKey,
    ]);

    const symmetricPrevious = grouped(
      ['A', '', 'B', '', 'C'],
      ['A', 'B', 'C'],
      [2],
    );
    const symmetricGroups = placeholderGroups(symmetricPrevious);
    const symmetricNext = grouped(
      ['A', '', 'B', '', 'C'],
      ['A', 'B', 'C'],
      [4],
      symmetricGroups,
    );
    expect(placeholderGroups(symmetricNext).map(({ placeholderKey }) => placeholderKey)).toEqual([
      symmetricGroups[0]?.placeholderKey,
      symmetricGroups[1]?.placeholderKey,
    ]);
  });

  test('maximizes monotonic key reuse across every small ordered partition pair', () => {
    for (let memberCount = 1; memberCount <= 6; memberCount += 1) {
      const ids = Array.from({ length: memberCount }, (_, index) => `M${index}`);
      const rawLines = ids.flatMap((id, index) => (
        index + 1 < ids.length ? [id, ''] : [id]
      ));
      const blocks = ids.map((id, index) => ({
        ...block(
          range(index * 2, index * 2 + 1),
          [range(index * 2, index * 2 + 1)],
          [],
          range(index * 2, index * 2 + 1),
          id,
        ),
        id,
      }));
      const partitionCount = 1 << Math.max(0, memberCount - 1);
      const barriers = (mask: number) => Array.from(
        { length: memberCount - 1 },
        (_, index) => index,
      ).filter((index) => (mask & (1 << index)) !== 0)
        .map((index) => (index + 1) * 2);

      for (let previousMask = 0; previousMask < partitionCount; previousMask += 1) {
        const previous = coalesceAdjacentToolProjection(projectToolLines(rawLines, {
          blocks,
          placeholder: () => 'hidden tools',
        }), { barrierLines: barriers(previousMask) });
        const previousGroups = placeholderGroups(previous);
        const previousKeys = new Set(previousGroups.map(({ placeholderKey }) => placeholderKey));

        for (let nextMask = 0; nextMask < partitionCount; nextMask += 1) {
          const next = coalesceAdjacentToolProjection(projectToolLines(rawLines, {
            blocks,
            placeholder: () => 'hidden tools',
          }), {
            barrierLines: barriers(nextMask),
            previousGroups,
          });
          const nextGroups = placeholderGroups(next);
          const nextKeys = nextGroups.map(({ placeholderKey }) => placeholderKey);
          expect(new Set(nextKeys).size).toBe(nextKeys.length);
          const carriedCount = nextKeys.filter((key) => previousKeys.has(key)).length;
          const maximumMatches = Array.from(
            { length: previousGroups.length + 1 },
            () => Array<number>(nextGroups.length + 1).fill(0),
          );
          for (let previousIndex = 1; previousIndex <= previousGroups.length; previousIndex += 1) {
            for (let nextIndex = 1; nextIndex <= nextGroups.length; nextIndex += 1) {
              const previousMembers = new Set(
                previousGroups[previousIndex - 1]?.memberPlaceholderKeys ?? [],
              );
              const overlaps = nextGroups[nextIndex - 1]?.memberPlaceholderKeys.some(
                (key) => previousMembers.has(key),
              ) ?? false;
              maximumMatches[previousIndex]![nextIndex] = Math.max(
                maximumMatches[previousIndex - 1]?.[nextIndex] ?? 0,
                maximumMatches[previousIndex]?.[nextIndex - 1] ?? 0,
                overlaps
                  ? (maximumMatches[previousIndex - 1]?.[nextIndex - 1] ?? 0) + 1
                  : 0,
              );
            }
          }
          const expectedCarriedCount = maximumMatches.at(-1)?.at(-1) ?? 0;
          if (carriedCount !== expectedCarriedCount) {
            throw new Error(JSON.stringify({
              memberCount,
              previousMask,
              nextMask,
              previous: previousGroups.map((group) => group.memberPlaceholderKeys),
              next: nextGroups.map((group) => group.memberPlaceholderKeys),
              previousKeys: [...previousKeys],
              nextKeys,
              carriedCount,
              expectedCarriedCount,
            }));
          }
        }
      }
    }
  });

  test('rejects malformed ranges and every participant in an overlap', () => {
    const rawLines = ['a', 'b', 'c', 'd', 'e'];
    const incomplete = block(range(0, 3), [range(0, 1)], [], range(0, 3), 'incomplete');
    const overlapA = block(range(1, 4), [range(1, 4)], [], range(1, 4), 'overlap-a');
    const overlapB = block(range(3, 5), [range(3, 5)], [], range(3, 5), 'overlap-b');
    const outside = block(range(0, 2), [range(0, 3)], [], range(0, 2), 'outside');

    const validation = validateToolCollapseBlocks(rawLines, [
      incomplete,
      overlapA,
      overlapB,
      outside,
    ]);
    expect(validation.acceptedBlocks).toEqual([]);
    expect(validation.rejectedBlocks.map(({ reason }) => reason)).toEqual([
      'source-not-fully-classified',
      'block-overlap',
      'block-overlap',
      'range-outside-source',
    ]);

    const projection = projectToolLines(rawLines, { blocks: [overlapA, overlapB] });
    expect(projection.lines).toBe(rawLines);
    expect(projection.hiddenLineCount).toBe(0);
  });

  test('rejects duplicate occurrence ids even when fingerprints may legitimately repeat', () => {
    const rawLines = ['first', '', 'second', ''];
    const first = block(range(0, 1), [range(0, 1)], [], range(0, 2), 'same-content');
    const second = {
      ...block(range(2, 3), [range(2, 3)], [], range(2, 4), 'same-content'),
      id: first.id,
    };
    const validation = validateToolCollapseBlocks(rawLines, [first, second]);

    expect(validation.acceptedBlocks).toEqual([]);
    expect(validation.rejectedBlocks.map(({ reason }) => reason)).toEqual([
      'duplicate-id',
      'duplicate-id',
    ]);
  });

  test('fingerprint and placeholder identity survive ANSI repaint and raw-row shifts', () => {
    const firstFingerprint = stableToolFingerprint(
      'codex',
      'background-wait',
      'completed',
      ['\x1b[1mWaited\x1b[0m', 'bun   test'],
    );
    const repaintedFingerprint = stableToolFingerprint(
      'codex',
      'background-wait',
      'completed',
      ['\x1b[0;1mWaited\x1b[0m', 'bun\ntest'],
    );
    expect(repaintedFingerprint).toBe(firstFingerprint);

    const wrappedUrl = stableToolFingerprint(
      'codex',
      'background-wait',
      'completed',
      ['https://example.test/verylong', 'token'],
    );
    const unwrappedUrl = stableToolFingerprint(
      'codex',
      'background-wait',
      'completed',
      ['https://example.test/verylongtoken'],
    );
    expect(wrappedUrl).toBe(unwrappedUrl);

    const first = projectToolLines(['', 'wait', 'command', ''], {
      blocks: [block(
        range(1, 3),
        [range(1, 3)],
        [],
        range(1, 4),
        firstFingerprint,
      )],
    });
    const shifted = projectToolLines(['older', 'history', '', 'wait repaint', 'command', ''], {
      blocks: [block(
        range(3, 5),
        [range(3, 5)],
        [],
        range(3, 6),
        repaintedFingerprint,
      )],
    });

    expect(first.rows.find((row) => row.kind === 'tool-placeholder')?.placeholderKey)
      .toBe(shifted.rows.find((row) => row.kind === 'tool-placeholder')?.placeholderKey);
  });

  test('reconciles occurrence identity when older rows reflow before the same block', () => {
    const fingerprint = stableToolFingerprint(
      'codex',
      'run-group',
      'succeeded',
      ['Ran 2 commands'],
    );
    const before = {
      ...block(
        range(2, 3),
        [range(2, 3)],
        [],
        range(2, 3),
        fingerprint,
      ),
      id: `${fingerprint}:row-102`,
    };
    const afterReflow = {
      ...block(
        range(3, 4),
        [range(3, 4)],
        [],
        range(3, 4),
        fingerprint,
      ),
      id: `${fingerprint}:row-103`,
    };
    const reconciled = reconcileToolBlockIds([before], [afterReflow]);

    expect(reconciled[0]?.id).toBe(before.id);
    const beforeKey = projectToolLines(['old', '', 'tool'], { blocks: [before] })
      .rows.find((row) => row.kind === 'tool-placeholder')?.placeholderKey;
    const afterKey = projectToolLines(['old-a', 'old-b', '', 'tool'], {
      blocks: reconciled,
    }).rows.find((row) => row.kind === 'tool-placeholder')?.placeholderKey;
    expect(afterKey).toBe(beforeKey);
  });

  test('ignores detector row-id collisions across uniform two- and three-block reflows', () => {
    const fingerprint = 'tool-v1-uniform-reflow';
    const occurrence = (startLine: number) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id: `${fingerprint}:row-${startLine}`,
    });
    const previousTwo = [occurrence(0), occurrence(5)];
    // The first new provisional id now equals the second previous id. It is a
    // physical-row collision caused by reflow, not proof that B became first.
    const nextTwo = [occurrence(5), occurrence(10)];
    const reflowedTwo = reconcileToolBlockIds(previousTwo, nextTwo);
    expect(reflowedTwo.map(({ id }) => id))
      .toEqual([`${fingerprint}:row-0`, `${fingerprint}:row-5`]);
    const stableTwo = reconcileToolBlockIds(reflowedTwo, [occurrence(5), occurrence(10)]);
    expect(stableTwo.map(({ id }) => id))
      .toEqual([`${fingerprint}:row-0`, `${fingerprint}:row-5`]);
    expect(reconcileToolBlockIds(stableTwo, [
      occurrence(5),
      occurrence(10),
      occurrence(15),
    ]).map(({ id }) => id)).toEqual([
      `${fingerprint}:row-0`,
      `${fingerprint}:row-5`,
      `${fingerprint}:row-15`,
    ]);

    const previousThree = [
      occurrence(0),
      occurrence(5),
      occurrence(10),
    ];
    const nextThree = [
      occurrence(5),
      occurrence(10),
      occurrence(15),
    ];
    expect(reconcileToolBlockIds(previousThree, nextThree).map(({ id }) => id))
      .toEqual([
        `${fingerprint}:row-0`,
        `${fingerprint}:row-5`,
        `${fingerprint}:row-10`,
      ]);
  });

  test('keeps monotonic survivors across simultaneous reflow/append and front drop', () => {
    const fingerprint = 'tool-v1-reflow-lifecycle';
    const occurrence = (startLine: number) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id: `${fingerprint}:row-${startLine}`,
    });

    const previousTwo = [occurrence(0), occurrence(5)];
    expect(reconcileToolBlockIds(previousTwo, [
      occurrence(5), occurrence(10), occurrence(15),
    ]).map(({ id }) => id)).toEqual([
      `${fingerprint}:row-0`,
      `${fingerprint}:row-5`,
      `${fingerprint}:row-15`,
    ]);

    const previousThree = [occurrence(0), occurrence(5), occurrence(10)];
    expect(reconcileToolBlockIds(previousThree, [occurrence(5), occurrence(10)])
      .map(({ id }) => id)).toEqual([
      `${fingerprint}:row-5`,
      `${fingerprint}:row-10`,
    ]);
  });

  test('reconciles an overflow window before applying the 512-block projection cap', () => {
    const fingerprint = 'tool-v1-cap-window';
    const occurrence = (startLine: number) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id: `${fingerprint}:row-${startLine}`,
    });
    const previous = Array.from({ length: 512 }, (_, index) => occurrence(index * 2));
    const candidates513 = Array.from({ length: 513 }, (_, index) => occurrence(index * 2));
    const firstWindow = reconcileToolBlockIds(previous, candidates513).slice(-512);
    const previousIds = new Set(previous.map(({ id }) => id));
    expect(firstWindow).toHaveLength(512);
    expect(firstWindow[0]?.id).toBe(`${fingerprint}:row-2`);
    expect(firstWindow.at(-1)?.id).toBe(`${fingerprint}:row-1024`);
    expect(firstWindow.filter(({ id }) => previousIds.has(id))).toHaveLength(511);

    // The next detector batch exposes the whole retained 512 plus 512 new
    // candidates (1024 total). Slicing only after reconciliation correctly
    // ejects every former occurrence without shifting its key onto new work.
    const candidates1024 = Array.from({ length: 1024 }, (_, index) => (
      occurrence((index + 1) * 2)
    ));
    const secondWindow = reconcileToolBlockIds(firstWindow, candidates1024).slice(-512);
    const firstWindowIds = new Set(firstWindow.map(({ id }) => id));
    expect(secondWindow).toHaveLength(512);
    expect(secondWindow[0]?.id).toBe(`${fingerprint}:row-1026`);
    expect(secondWindow.at(-1)?.id).toBe(`${fingerprint}:row-2048`);
    expect(secondWindow.filter(({ id }) => firstWindowIds.has(id))).toHaveLength(0);
  });

  test('uses monotonic min-cost subsets for duplicate insertion and deletion', () => {
    const fingerprint = 'tool-v1-insert-delete';
    const occurrence = (startLine: number, id: string) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id,
    });

    const inserted = reconcileToolBlockIds(
      [occurrence(0, 'A'), occurrence(10, 'B')],
      [occurrence(1, 'new-1'), occurrence(5, 'new-5'), occurrence(11, 'new-11')],
    );
    expect(inserted.map(({ id }) => id)).toEqual(['A', 'new-5', 'B']);

    const deleted = reconcileToolBlockIds(
      [occurrence(0, 'A'), occurrence(5, 'B'), occurrence(10, 'C')],
      [occurrence(6, 'new-6'), occurrence(11, 'new-11')],
    );
    expect(deleted.map(({ id }) => id)).toEqual(['B', 'C']);
  });

  test('uses exact identities as corridor anchors for duplicate reconciliation', () => {
    const fingerprint = 'tool-v1-exact-anchor';
    const occurrence = (startLine: number, id: string) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id,
    });
    const previous = [
      occurrence(0, 'before-a'),
      occurrence(2, 'before-b'),
      occurrence(10, 'anchor'),
      occurrence(20, 'after-a'),
      occurrence(30, 'after-b'),
    ];
    const next = [
      occurrence(9, 'new-before'),
      occurrence(10, 'anchor'),
      occurrence(11, 'new-after-a'),
      occurrence(31, 'new-after-b'),
    ];

    expect(reconcileToolBlockIds(previous, next).map(({ id }) => id)).toEqual([
      'before-b',
      'anchor',
      'after-a',
      'after-b',
    ]);
  });

  test('uses monotonic source matching when detector origin is inconsistent', () => {
    const fingerprint = 'tool-v1-mixed-anchor';
    const occurrence = (startLine: number, id: string) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id,
    });
    const previous = [
      occurrence(0, `${fingerprint}:row-0`),
      occurrence(5, `${fingerprint}:row-5`),
    ];
    const next = [
      // False collision: B cannot map before A in an insertion corridor.
      occurrence(5, `${fingerprint}:row-5`),
      // This looks exact in isolation, but its origin disagrees with the other
      // next rows, so only the global monotonic source alignment may carry it.
      occurrence(10, `${fingerprint}:row-0`),
      occurrence(15, `${fingerprint}:row-15`),
    ];

    expect(reconcileToolBlockIds(previous, next).map(({ id }) => id)).toEqual([
      `${fingerprint}:row-0`,
      `${fingerprint}:row-5`,
      `${fingerprint}:row-15`,
    ]);

    const corridorPrevious = [
      occurrence(0, `${fingerprint}:row-0`),
      occurrence(5, `${fingerprint}:row-5`),
      occurrence(10, `${fingerprint}:row-10`),
      occurrence(15, `${fingerprint}:row-15`),
    ];
    const corridorCollision = [
      occurrence(4, `${fingerprint}:row-5`),
      occurrence(9, `${fingerprint}:row-9`),
      occurrence(14, `${fingerprint}:row-10`),
    ];
    // The exact-looking endpoints imply different origins from the middle row,
    // so global monotonic cost—not either isolated exact—is authoritative.
    expect(reconcileToolBlockIds(corridorPrevious, corridorCollision).map(({ id }) => id))
      .toEqual([
        `${fingerprint}:row-5`,
        `${fingerprint}:row-10`,
        `${fingerprint}:row-15`,
      ]);
  });

  test('preserves same-origin exact prefixes during pure append', () => {
    const fingerprint = 'tool-v1-ambiguous-prefix';
    const occurrence = (startLine: number) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id: `${fingerprint}:row-${startLine}`,
    });
    const previous = [occurrence(0), occurrence(5)];
    const next = [occurrence(0), occurrence(5), occurrence(10)];

    // New completed history appends. Historical prefix insertion changes the
    // detector origin, so same-origin, same-rank exact rows prove retained A/B.
    expect(reconcileToolBlockIds(previous, next).map(({ id }) => id)).toEqual([
      `${fingerprint}:row-0`,
      `${fingerprint}:row-5`,
      `${fingerprint}:row-10`,
    ]);
  });

  test('keeps detector absolute ids through prepend and exact survivor eviction', () => {
    const fingerprint = 'tool-v1-prepend-evict';
    const occurrence = (startLine: number, id: string) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id,
    });
    const previous = [
      occurrence(1, `${fingerprint}:row-101`),
      occurrence(3, `${fingerprint}:row-103`),
    ];
    const prepended = [
      occurrence(3, `${fingerprint}:row-101`),
      occurrence(5, `${fingerprint}:row-103`),
    ];
    expect(reconcileToolBlockIds(previous, prepended).map(({ id }) => id)).toEqual([
      `${fingerprint}:row-101`,
      `${fingerprint}:row-103`,
    ]);

    const afterEviction = [occurrence(1, `${fingerprint}:row-103`)];
    expect(reconcileToolBlockIds(previous, afterEviction)[0]?.id)
      .toBe(`${fingerprint}:row-103`);
  });

  test('uses changed detector origins for rolling drop-prefix and append-suffix retention', () => {
    const fingerprint = 'tool-v1-rolling-retention';
    const occurrence = (startLine: number, absoluteRow: number) => ({
      ...block(
        range(startLine, startLine + 1),
        [range(startLine, startLine + 1)],
        [],
        range(startLine, startLine + 1),
        fingerprint,
      ),
      id: `${fingerprint}:row-${absoluteRow}`,
    });

    const previousTwo = [occurrence(0, 100), occurrence(5, 105)];
    const rollingTwo = [occurrence(0, 105), occurrence(5, 110)];
    const reconciledTwo = reconcileToolBlockIds(previousTwo, rollingTwo);
    expect(reconciledTwo.map(({ id }) => id)).toEqual([
      `${fingerprint}:row-105`,
      `${fingerprint}:row-110`,
    ]);
    expect(reconcileToolBlockIds(reconciledTwo, [occurrence(0, 105), occurrence(5, 110)])
      .map(({ id }) => id)).toEqual([
      `${fingerprint}:row-105`,
      `${fingerprint}:row-110`,
    ]);

    const previousThree = [
      occurrence(0, 100),
      occurrence(5, 105),
      occurrence(10, 110),
    ];
    const rollingFour = [
      occurrence(0, 105),
      occurrence(5, 110),
      occurrence(10, 115),
      occurrence(15, 120),
    ];
    expect(reconcileToolBlockIds(previousThree, rollingFour).map(({ id }) => id)).toEqual([
      `${fingerprint}:row-105`,
      `${fingerprint}:row-110`,
      `${fingerprint}:row-115`,
      `${fingerprint}:row-120`,
    ]);
  });

  test('reconciles duplicate fingerprints by nearest source location with stable ties', () => {
    const fingerprint = 'tool-v1-duplicate-location';
    const previousA = {
      ...block(range(10, 11), [range(10, 11)], [], range(10, 11), fingerprint),
      id: `${fingerprint}:A`,
    };
    const previousB = {
      ...block(range(20, 21), [range(20, 21)], [], range(20, 21), fingerprint),
      id: `${fingerprint}:B`,
    };
    const survivingB = {
      ...block(range(21, 22), [range(21, 22)], [], range(21, 22), fingerprint),
      id: `${fingerprint}:provisional-21`,
    };

    expect(reconcileToolBlockIds([previousA, previousB], [survivingB])[0]?.id)
      .toBe(previousB.id);

    const equidistant = {
      ...block(range(15, 16), [range(15, 16)], [], range(15, 16), fingerprint),
      id: `${fingerprint}:provisional-15`,
    };
    // Equal distance is deterministic: the lower previous source location wins.
    expect(reconcileToolBlockIds([previousA, previousB], [equidistant])[0]?.id)
      .toBe(previousA.id);
  });

  test('disabled projection is an exact identity operation', () => {
    const rawLines = ['header', 'output'];
    const projection = projectToolLines(rawLines, {
      enabled: false,
      blocks: [block(range(0, 2), [range(0, 2)])],
    });

    expect(projection.rawLines).toBe(rawLines);
    expect(projection.lines).toBe(rawLines);
    expect(projection.rawToVisual).toEqual([0, 1]);
    expect(projection.projectedBlocks).toEqual([]);
  });
});
