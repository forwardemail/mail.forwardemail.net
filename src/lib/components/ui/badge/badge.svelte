<script lang="ts" module>
  import { type VariantProps, tv } from 'tailwind-variants';

  export const badgeVariants = tv({
    base: 'focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] [&>svg]:pointer-events-none [&>svg]:size-3.5',
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90 border-transparent',
        secondary:
          'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90 border-transparent',
        destructive:
          'bg-destructive [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/70 border-transparent text-white',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        // Semantic state variants, mapped onto the state tokens so a chip can
        // state a fact without a caller picking colours by hand. Each resolves
        // per theme: the light values are the AA-safe -deep variants.
        success: 'bg-state-success/10 text-state-success border-state-success/30',
        caution: 'bg-state-caution/10 text-state-caution border-state-caution/30',
        active: 'bg-state-active/10 text-state-active border-state-active/30',
        // Encryption is deliberately NOT success: delivered and encrypted are
        // different facts and must not share a colour (specification §5.3).
        encrypted: 'bg-state-encrypted/10 text-state-encrypted border-state-encrypted/30',
      },
      /**
       * The mono label treatment from specification §4.2. Opt-in rather than
       * the default: existing badges carry sentence-case content such as email
       * addresses and folder names, where uppercase monospace costs more
       * legibility than it buys brand. Use it for fixed vocabularies such as
       * status, tier or execution location.
       */
      mono: {
        true: 'fe-type-label !text-[length:var(--type-label-size)] px-2.5',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      mono: false,
    },
  });

  export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes } from 'svelte/elements';
  import { cn, type WithElementRef } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    href,
    class: className,
    variant = 'default',
    mono = false,
    children,
    ...restProps
  }: WithElementRef<HTMLAnchorAttributes> & {
    variant?: BadgeVariant;
    mono?: boolean;
  } = $props();
</script>

<svelte:element
  this={href ? 'a' : 'span'}
  bind:this={ref}
  data-slot="badge"
  {href}
  class={cn(badgeVariants({ variant, mono }), className)}
  {...restProps}
>
  {@render children?.()}
</svelte:element>
