import {
  cloneSgrState,
  createSgrState,
  lineToHtml,
  sgrStateKey,
  type AnsiPalette,
  type SgrState,
} from './ansi-html';

const STATE_ONLY_PALETTE: AnsiPalette = {
  base: [
    '#000000', '#800000', '#008000', '#808000',
    '#000080', '#800080', '#008080', '#c0c0c0',
    '#808080', '#ff0000', '#00ff00', '#ffff00',
    '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
  ],
  defaultFg: '#ffffff',
  defaultBg: '#000000',
};

export function planPrepend(
  batch: string[],
  firstExistingLineRaw: string,
  existingFirstState: SgrState,
): {
  batchStates: SgrState[];
  endState: SgrState;
  existingCacheValid: boolean;
} {
  void firstExistingLineRaw;

  const st = createSgrState();
  const batchStates: SgrState[] = [];
  for (const line of batch) {
    lineToHtml(line, st, STATE_ONLY_PALETTE);
    batchStates.push(cloneSgrState(st));
  }

  const endState = cloneSgrState(st);
  return {
    batchStates,
    endState,
    existingCacheValid: sgrStateKey(endState) === sgrStateKey(existingFirstState),
  };
}
