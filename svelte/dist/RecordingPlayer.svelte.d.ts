import { type AnsiPalette } from '@thumbmux/core';
import { type ReplayJournalLike } from './recording-player';
type RecordedFrame = {
    recordIndex: number;
    lines: readonly string[];
};
type $$ComponentProps = {
    journal: ReplayJournalLike<RecordedFrame>;
    palette: AnsiPalette;
};
declare const RecordingPlayer: import("svelte").Component<$$ComponentProps, {}, "">;
type RecordingPlayer = ReturnType<typeof RecordingPlayer>;
export default RecordingPlayer;
