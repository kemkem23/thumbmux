<script lang="ts">
  import { ThumbmuxApp, type AppAdapters } from "thumbmux/app";
  import type { SubmitAgent } from "thumbmux/core";

  const codex: SubmitAgent = "codex";
  const adapters: AppAdapters = {
    submitAgent: () => codex,
  };
</script>

<ThumbmuxApp {adapters} />
