<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui';

  let {
    open = $bindable(false),
    delayDuration = 100,
    ...restProps
  }: TooltipPrimitive.RootProps = $props();
</script>

<TooltipPrimitive.Root bind:open {delayDuration} {...restProps} />
