<!--
  FROZEN CONSUMER FIXTURE (RULES §9).
  Changes require a matching contract manifest change and the CONTRACT.md
  deprecation procedure.
-->
<script lang="ts">
  import type { SubmitAgent } from "thumbmux/core";
  import { ThumbmuxApp, type AppAdapters } from "thumbmux/app";

  const agent = ["co", "dex"].join("") as SubmitAgent;
  const adapters: AppAdapters = {
    submitAgent: () => agent,
    termProps: () => ({ claimGeometry: false }),
  };
</script>

<ThumbmuxApp {adapters} />
