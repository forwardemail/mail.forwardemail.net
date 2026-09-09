<script lang="ts">
  // Hosts MessageTab under the Tooltip provider the app supplies at its root.
  import * as Tooltip from '$lib/components/ui/tooltip';
  import MessageTab from '../../../src/svelte/components/MessageTab.svelte';
  let { ...props } = $props();
</script>

<Tooltip.Provider>
  <MessageTab {...props} />
</Tooltip.Provider>
