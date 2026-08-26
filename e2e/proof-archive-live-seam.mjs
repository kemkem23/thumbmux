#!/usr/bin/env node

// Historical artifact only. The former standalone proof accepted an arbitrary
// DEMO_URL and drove the process-visible host tmux directly. That execution
// shape is permanently disabled: the maintained proof is archive-live-seam.spec.ts
// and may run only through ./e2e/run-container.sh in the attested public CI job.
throw new Error(
  'disabled unsafe historical proof; use the attested e2e/run-container.sh suite',
);
