import { type AnsiPalette } from '../core/index.js';
import { type ReplayJournalLike } from './recording-player.js';
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
