<script lang="ts">
  import * as thumbmuxSvelte from "thumbmux/svelte";
  import * as thumbmuxApp from "thumbmux/app";

  const exportedNames = Object.keys(thumbmuxSvelte).sort();
  const appExportedNames = Object.keys(thumbmuxApp).sort();
</script>

<main data-export-count={exportedNames.length} data-app-export-count={appExportedNames.length}>
  {exportedNames.join(", ")}
  {appExportedNames.join(", ")}
</main>
