<!--
  Terminal stand-in for Lucide's <Icon>, which every lucide-svelte and
  @lucide/svelte icon renders through. The terminal build resolves their
  ./Icon.svelte to this file (vite.cli.config.js): the same element classes
  and attributes, with a text glyph in place of SVG paths a terminal cannot
  draw.
-->
<script>
  import { glyphFor } from '../icons';

  let {
    name,
    color: _color,
    size: _size,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    iconNode: _iconNode,
    children,
    class: className,
    ...props
  } = $props();

  const labelled = $derived(
    Object.keys(props).some(
      (key) => key === 'aria-label' || key === 'aria-labelledby' || key === 'title',
    ),
  );
</script>

<span
  aria-hidden={labelled ? undefined : 'true'}
  {...props}
  class={['lucide-icon lucide', name && `lucide-${name}`, className]}
  >{glyphFor(name)}{@render children?.()}</span
>
