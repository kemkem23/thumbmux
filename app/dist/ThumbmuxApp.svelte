<script lang="ts">
  import { onMount } from 'svelte';
  import type { AppAdapters } from './config';
  import HubView from './HubView.svelte';
  import { createQueryParamNav } from './navigation';
  import SessionView from './SessionView.svelte';

  let { adapters }: { adapters: AppAdapters } = $props();

  let session = $state<string | null>(null);
  let internalRoutes = $state<AppAdapters['routes']>();
  let viewAdapters = $derived(
    internalRoutes ? { ...adapters, routes: internalRoutes } : adapters,
  );

  function openInternalSession(name: string): void {
    internalRoutes?.openSession(name);
  }

  onMount(() => {
    if (adapters.routes) return;

    const navigation = createQueryParamNav();
    internalRoutes = {
      openSession: navigation.openSession,
      showHub: navigation.showHub,
    };
    const unsubscribe = navigation.subscribe((nextSession) => {
      session = nextSession;
    });

    return () => {
      unsubscribe();
      navigation.dispose();
    };
  });
</script>

{#if internalRoutes && session}
  <SessionView {session} adapters={viewAdapters} />
{:else}
  <HubView adapters={viewAdapters} onOpen={openInternalSession} />
{/if}
