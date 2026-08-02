import type { FrameJournalRecordV1 } from "../src/index";
import type { JournalRecordV1 as CoreJournalRecordV1 } from "@thumbmux/core";

// The server alias completed its deprecation window in v0.9.0.
// @ts-expect-error JournalRecordV1 is no longer exported from thumbmux/server.
import type { JournalRecordV1 } from "../src/index";

export type ReplacementRemainsPublic = FrameJournalRecordV1;
export type UnrelatedCoreNameRemainsPublic = CoreJournalRecordV1;
