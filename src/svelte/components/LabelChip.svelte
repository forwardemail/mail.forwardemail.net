<script lang="ts">
  import { readableForeground } from '../../utils/contrast';

  interface LabelDef {
    name?: string;
    label?: string;
    value?: string;
    color?: string;
  }

  interface Props {
    keyword: string;
    def?: LabelDef | null;
    size?: 'sm' | 'md';
  }

  let { keyword, def = null, size = 'sm' }: Props = $props();

  const text = $derived(def?.name || def?.label || def?.value || keyword);
  const style = $derived(
    def?.color ? `background:${def.color}; color:${readableForeground(def.color)};` : '',
  );
</script>

<!-- The clipping lives on the inner span, not the pill. With overflow:hidden on a
     rounded-full pill the curved corners shave the first and last glyphs, and
     text-overflow never applies to a flex container's anonymous text item, so long
     names were hard clipped with no ellipsis. -->
<span
  class="inline-flex min-w-0 items-center rounded-full whitespace-nowrap {size === 'md'
    ? 'max-w-[160px] px-2.5 py-0.5 text-xs leading-4'
    : 'max-w-[120px] px-2 py-px text-[10px] leading-[14px]'} {def?.color
    ? ''
    : 'bg-secondary text-secondary-foreground'}"
  {style}
  title={text}
>
  <span class="min-w-0 truncate">{text}</span>
</span>
