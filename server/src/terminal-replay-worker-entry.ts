import { runTerminalReplayWorkerStdio } from "./integrations/terminal-replay-worker";

try {
  const exitCode = await runTerminalReplayWorkerStdio();
  process.exitCode = exitCode;
} catch (error) {
  // stdout is protocol-only. Diagnostics must never corrupt framed IPC.
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`thumbmux terminal replay worker failed: ${message}\n`);
  process.exitCode = 1;
}
