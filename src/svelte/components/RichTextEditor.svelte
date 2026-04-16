<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import LinkBase from '@tiptap/extension-link';
  import Placeholder from '@tiptap/extension-placeholder';
  import Underline from '@tiptap/extension-underline';
  import Bold from '@lucide/svelte/icons/bold';
  import Italic from '@lucide/svelte/icons/italic';
  import UnderlineIcon from '@lucide/svelte/icons/underline';
  import List from '@lucide/svelte/icons/list';
  import ListOrdered from '@lucide/svelte/icons/list-ordered';
  import LinkIcon from '@lucide/svelte/icons/link';
  import { Button } from '$lib/components/ui/button';

  interface Props {
    value?: string;
    placeholder?: string;
    minHeight?: string;
    onChange?: (html: string) => void;
  }

  let {
    value = $bindable(''),
    placeholder = 'Start typing...',
    minHeight = '160px',
    onChange = () => {},
  }: Props = $props();

  let container: HTMLDivElement;
  let editor: Editor | null = null;
  let isActive = $state({
    bold: false,
    italic: false,
    underline: false,
    bulletList: false,
    orderedList: false,
    link: false,
  });

  const Link = LinkBase.configure({
    openOnClick: false,
    autolink: true,
    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
  });

  function syncActiveStates() {
    if (!editor) return;
    isActive = {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      link: editor.isActive('link'),
    };
  }

  onMount(() => {
    editor = new Editor({
      element: container,
      extensions: [StarterKit, Underline, Link, Placeholder.configure({ placeholder })],
      content: value || '',
      onUpdate: ({ editor: ed }) => {
        const html = ed.getHTML();
        value = html;
        onChange(html);
        syncActiveStates();
      },
      onSelectionUpdate: syncActiveStates,
    });
  });

  onDestroy(() => {
    editor?.destroy();
  });

  // Keep editor in sync when value is changed externally (e.g. mode switch)
  $effect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (value !== current && typeof value === 'string') {
      editor.commands.setContent(value || '', false);
    }
  });

  function toggleBold() {
    editor?.chain().focus().toggleBold().run();
  }
  function toggleItalic() {
    editor?.chain().focus().toggleItalic().run();
  }
  function toggleUnderline() {
    editor?.chain().focus().toggleUnderline().run();
  }
  function toggleBulletList() {
    editor?.chain().focus().toggleBulletList().run();
  }
  function toggleOrderedList() {
    editor?.chain().focus().toggleOrderedList().run();
  }

  function addLink() {
    if (!editor) return;
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('URL', prev);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }
</script>

<div class="rte-root">
  <div class="rte-toolbar" role="toolbar">
    <Button
      type="button"
      variant={isActive.bold ? 'secondary' : 'ghost'}
      size="icon"
      onclick={toggleBold}
      aria-label="Bold"
    >
      <Bold class="h-4 w-4" />
    </Button>
    <Button
      type="button"
      variant={isActive.italic ? 'secondary' : 'ghost'}
      size="icon"
      onclick={toggleItalic}
      aria-label="Italic"
    >
      <Italic class="h-4 w-4" />
    </Button>
    <Button
      type="button"
      variant={isActive.underline ? 'secondary' : 'ghost'}
      size="icon"
      onclick={toggleUnderline}
      aria-label="Underline"
    >
      <UnderlineIcon class="h-4 w-4" />
    </Button>
    <div class="rte-sep"></div>
    <Button
      type="button"
      variant={isActive.bulletList ? 'secondary' : 'ghost'}
      size="icon"
      onclick={toggleBulletList}
      aria-label="Bulleted list"
    >
      <List class="h-4 w-4" />
    </Button>
    <Button
      type="button"
      variant={isActive.orderedList ? 'secondary' : 'ghost'}
      size="icon"
      onclick={toggleOrderedList}
      aria-label="Numbered list"
    >
      <ListOrdered class="h-4 w-4" />
    </Button>
    <div class="rte-sep"></div>
    <Button
      type="button"
      variant={isActive.link ? 'secondary' : 'ghost'}
      size="icon"
      onclick={addLink}
      aria-label="Link"
    >
      <LinkIcon class="h-4 w-4" />
    </Button>
  </div>
  <div bind:this={container} class="rte-surface" style="min-height: {minHeight}"></div>
</div>

<style>
  .rte-root {
    border: 1px solid hsl(var(--border));
    border-radius: 6px;
    background: hsl(var(--background));
    overflow: hidden;
  }
  .rte-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border-bottom: 1px solid hsl(var(--border));
    background: hsl(var(--muted) / 0.4);
  }
  .rte-sep {
    width: 1px;
    align-self: stretch;
    background: hsl(var(--border));
    margin: 4px 2px;
  }
  .rte-surface {
    padding: 10px 12px;
    font-size: 14px;
    line-height: 1.5;
    outline: none;
  }
  :global(.rte-surface .ProseMirror) {
    outline: none;
    min-height: inherit;
  }
  :global(.rte-surface p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    color: hsl(var(--muted-foreground));
    float: left;
    pointer-events: none;
    height: 0;
  }
  :global(.rte-surface a) {
    color: hsl(var(--primary));
    text-decoration: underline;
  }
  :global(.rte-surface ul) {
    list-style: disc;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  :global(.rte-surface ol) {
    list-style: decimal;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  :global(.rte-surface li) {
    margin: 0.25rem 0;
  }
  :global(.rte-surface li > p) {
    margin: 0;
  }
  :global(.rte-surface p) {
    margin: 0.5rem 0;
  }
  :global(.rte-surface blockquote) {
    border-left: 3px solid hsl(var(--border));
    padding-left: 0.75rem;
    margin: 0.5rem 0;
    color: hsl(var(--muted-foreground));
  }
  :global(.rte-surface strong) {
    font-weight: 600;
  }
  :global(.rte-surface em) {
    font-style: italic;
  }
</style>
