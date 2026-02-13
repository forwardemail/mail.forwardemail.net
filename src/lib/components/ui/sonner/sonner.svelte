<script lang="ts">
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
	import { mode } from "mode-watcher";

	let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme={mode.current}
	class="toaster group"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
	{...restProps}
	>{#snippet loadingIcon()}
		<LucideLoader2  class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<LucideCircleCheck  class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<LucideOctagonX  class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<LucideInfo  class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<LucideTriangleAlert  class="size-4" />
	{/snippet}
</Sonner>
