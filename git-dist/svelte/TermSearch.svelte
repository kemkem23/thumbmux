<script lang="ts">
  import { searchKeyIntent, type SearchDirection } from './term-search';

  type TermSearchProps = {
    query: string;
    matchCount: number;
    activeIndex: number;
    error?: string | null;
    onQueryChange: (query: string) => void;
    onNavigate: (direction: SearchDirection) => void;
    onClose: () => void;
  };

  let {
    query,
    matchCount,
    activeIndex,
    error = null,
    onQueryChange,
    onNavigate,
    onClose,
  }: TermSearchProps = $props();

  let inputEl = $state<HTMLInputElement | null>(null);

  export function focusInput(): void {
    inputEl?.focus({ preventScroll: true });
  }

  function handleInput(event: Event): void {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      onQueryChange(target.value);
    }
  }

  function handleInputKeydown(event: KeyboardEvent): void {
    const intent = searchKeyIntent(event, 'input');
    if (!intent) return;

    event.preventDefault();
    event.stopPropagation();

    if (intent === 'next' || intent === 'previous') {
      onNavigate(intent);
      return;
    }

    onClose();
  }

  const matchCountText = $derived.by(() =>
    matchCount <= 0 ? '0 matches' : `${matchCount} matches`
  );

  const activeMatchText = $derived.by(() => {
    if (matchCount <= 0) return 'No active match';
    if (activeIndex < 0 || activeIndex >= matchCount) return 'No active match';
    return `${activeIndex + 1} of ${matchCount}`;
  });
</script>

<section class="term-search" role="search" aria-label="Terminal search" data-testid="term-search">
  <label class="term-search__field">
    <span class="sr-only">Search terminal</span>
    <input
      bind:this={inputEl}
      id="term-search-input"
      data-testid="term-search-input"
      type="search"
      value={query}
      placeholder="Search terminal"
      aria-label="Terminal search"
      oninput={handleInput}
      onkeydown={handleInputKeydown}
    />
  </label>

  <div class="term-search__status" aria-live="polite">
    <p class="term-search__status-line" data-testid="term-search-match" role="status" aria-live="polite">
      Match count: {matchCountText}
    </p>
    <p class="term-search__status-line" data-testid="term-search-active" role="status" aria-live="polite">
      Active match: {activeMatchText}
    </p>
  </div>

  {#if error}
    <p class="term-search__error" role="alert" aria-live="polite">{error}</p>
  {/if}

  <div class="term-search__controls">
    <button type="button" class="term-search__btn" onclick={() => onNavigate('previous')} aria-label="Previous match">
      Previous
    </button>
    <button type="button" class="term-search__btn" onclick={() => onNavigate('next')} aria-label="Next match">
      Next
    </button>
    <button type="button" class="term-search__btn term-search__btn--close" onclick={onClose} aria-label="Close search">
      Close
    </button>
  </div>
</section>

<style>
  .term-search {
    display: grid;
    gap: 0.45rem;
    padding: 0.5rem;
    background: rgba(20, 20, 20, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 0.65rem;
    color: #eceff4;
    width: min(24rem, 100%);
    box-sizing: border-box;
    font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    backdrop-filter: blur(3px);
  }

  .term-search__field {
    width: 100%;
  }

  .term-search__field input[type='search'] {
    width: 100%;
    padding: 0.45rem 0.55rem;
    border-radius: 0.45rem;
    border: 1px solid rgba(255, 255, 255, 0.24);
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .term-search__field input[type='search']:focus-visible {
    border-color: rgba(129, 212, 250, 0.8);
    box-shadow: 0 0 0 1px rgba(129, 212, 250, 0.5);
  }

  .term-search__status {
    display: grid;
    gap: 0.2rem;
    margin-top: 0.15rem;
  }

  .term-search__status-line {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.2;
  }

  .term-search__error {
    margin: 0;
    font-size: 0.82rem;
    color: #ff9aa2;
  }

  .term-search__controls {
    display: flex;
    gap: 0.35rem;
  }

  .term-search__btn {
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 0.45rem;
    background: rgba(255, 255, 255, 0.08);
    color: #f8fafc;
    padding: 0.35rem 0.6rem;
    font-size: 0.82rem;
    line-height: 1.1;
    cursor: pointer;
  }

  .term-search__btn:hover,
  .term-search__btn:focus-visible {
    background: rgba(129, 212, 250, 0.2);
    outline: none;
  }

  .term-search__btn--close {
    margin-left: auto;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
