import {
  applyMuxDelta,
  createMuxDeltaFrame,
  splitMuxOutputData,
  type MuxClientMessage,
} from "thumbmux/core";
import {
  TmuxWsMux,
  createPrefsHandler,
  createUploadHandler,
  type TmuxDriver,
  type WsLike,
} from "thumbmux/server";
import type { GridSession, TmuxMuxOptions } from "thumbmux/svelte";

const request: MuxClientMessage = { type: "subscribe", session: "smoke", delta: true };
const driver = null as unknown as TmuxDriver;
const socket = null as unknown as WsLike;
const grid = null as unknown as GridSession;
const options = null as unknown as TmuxMuxOptions;
const base = splitMuxOutputData("one\ntwo");
const delta = createMuxDeltaFrame("smoke", base, ["one", "three"], null);
const reconstructed = applyMuxDelta(base, delta);

void request;
void driver;
void socket;
void grid;
void options;
void reconstructed;
void TmuxWsMux;
void createPrefsHandler;
void createUploadHandler;
