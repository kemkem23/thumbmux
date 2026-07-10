<script lang="ts">
  import * as thumbmuxSvelte from "thumbmux/svelte";

  const exportedNames = Object.keys(thumbmuxSvelte).sort();
</script>

<main data-export-count={exportedNames.length}>
  {exportedNames.join(", ")}
</main>
