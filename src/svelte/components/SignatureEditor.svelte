<script lang="ts">
  /**
   * Small rich-text editor for the account signature.
   *
   * Deliberately a much smaller toolbar than Compose: a signature only needs
   * emphasis, links and a little colour. It keeps both representations in sync
   * so plain-text mode always has something sensible to fall back to.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import Link from '@tiptap/extension-link';
  import Underline from '@tiptap/extension-underline';
  import TextStyle from '@tiptap/extension-text-style';
  import Color from '@tiptap/extension-color';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import Bold from '@lucide/svelte/icons/bold';
  import Italic from '@lucide/svelte/icons/italic';
  import UnderlineIcon from '@lucide/svelte/icons/underline';
  import Link2 from '@lucide/svelte/icons/link-2';
  import ListIcon from '@lucide/svelte/icons/list';
  import RemoveFormatting from '@lucide/svelte/icons/remove-formatting';
  import Type from '@lucide/svelte/icons/type';
  import FileText from '@lucide/svelte/icons/file-text';
  import { htmlToPlainText } from '../../utils/sanitize.js';

  interface Props {
    html?: string;
    text?: string;
    /** Fired on every edit with both representations. */
    onChange?: (value: { html: string; text: string }) => void;
  }

  let { html = '', text = '', onChange }: Props = $props();

  let editorEl = $state<HTMLDivElement | null>(null);
  let editor = $state<Editor | null>(null);
  let mode = $state<'rich' | 'plain'>(html.trim() ? 'rich' : 'plain');
  let plainValue = $state(text);
  // Re-read on every transaction so the toolbar's active states stay current.
  let selectionTick = $state(0);

  const emit = (nextHtml: string, nextText: string) => {
    html = nextHtml;
    text = nextText;
    onChange?.({ html: nextHtml, text: nextText });
  };

  const buildEditor = () => {
    if (!editorEl || editor) return;
    editor = new Editor({
      element: editorEl,
      extensions: [
        StarterKit.configure({ blockquote: false, codeBlock: false, heading: false }),
        Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
        Underline,
        TextStyle,
        Color,
      ],
      content: html || (text ? textToHtml(text) : ''),
      onUpdate: ({ editor: view }) => {
        const nextHtml = view.getHTML();
        // Keep the plain form derived from the rich one so the two never drift.
        emit(nextHtml, htmlToPlainText(nextHtml));
      },
      onSelectionUpdate: () => {
        selectionTick += 1;
      },
      onTransaction: () => {
        selectionTick += 1;
      },
    });
  };

  const textToHtml = (value: string) =>
    value
      .split('\n')
      .map((line) => (line.trim() ? escapeHtml(line) : '<br>'))
      .join('<br>');

  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  onMount(() => {
    if (mode === 'rich') buildEditor();
  });

  onDestroy(() => {
    editor?.destroy();
    editor = null;
  });

  const switchToPlain = () => {
    const current = editor ? htmlToPlainText(editor.getHTML()) : text;
    editor?.destroy();
    editor = null;
    plainValue = current;
    mode = 'plain';
    // Clearing the HTML is what makes plain mode stick: a leftover html value
    // would win again the next time Compose renders the signature.
    emit('', current);
  };

  const switchToRich = () => {
    mode = 'rich';
    const seeded = plainValue ? textToHtml(plainValue) : '';
    html = seeded;
    tick().then(() => {
      buildEditor();
      if (seeded) emit(seeded, plainValue);
    });
  };

  const onPlainInput = (value: string) => {
    plainValue = value;
    emit('', value);
  };

  const promptLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes('link')?.href || '';
    const url = window.prompt('Link URL', previous);
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  const isActive = (name: string, attrs?: Record<string, unknown>) => {
    void selectionTick;
    return Boolean(editor?.isActive(name, attrs));
  };
</script>

<div class="space-y-2">
  <div class="flex items-center justify-between gap-2">
    <span class="text-xs text-muted-foreground">
      {mode === 'rich' ? 'Formatted signature' : 'Plain text signature'}
    </span>
    <Button
      variant="ghost"
      size="sm"
      onclick={mode === 'rich' ? switchToPlain : switchToRich}
      data-testid="signature-toggle-format"
    >
      {#if mode === 'rich'}
        <FileText class="mr-2 h-4 w-4" />
        Use plain text
      {:else}
        <Type class="mr-2 h-4 w-4" />
        Use formatting
      {/if}
    </Button>
  </div>

  {#if mode === 'rich'}
    <div class="border border-border">
      <div class="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 p-1">
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8 {isActive('bold') ? 'bg-accent' : ''}"
          aria-label="Bold"
          aria-pressed={isActive('bold')}
          onclick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold class="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8 {isActive('italic') ? 'bg-accent' : ''}"
          aria-label="Italic"
          aria-pressed={isActive('italic')}
          onclick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic class="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8 {isActive('underline') ? 'bg-accent' : ''}"
          aria-label="Underline"
          aria-pressed={isActive('underline')}
          onclick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon class="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8 {isActive('bulletList') ? 'bg-accent' : ''}"
          aria-label="Bullet list"
          aria-pressed={isActive('bulletList')}
          onclick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <ListIcon class="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8 {isActive('link') ? 'bg-accent' : ''}"
          aria-label="Insert link"
          aria-pressed={isActive('link')}
          onclick={promptLink}
        >
          <Link2 class="h-4 w-4" />
        </Button>
        <label class="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
          <span class="sr-only">Text color</span>
          <input
            type="color"
            class="h-6 w-6 cursor-pointer border border-border bg-transparent p-0"
            aria-label="Text color"
            oninput={(e) =>
              editor
                ?.chain()
                .focus()
                .setColor((e.currentTarget as HTMLInputElement).value)
                .run()}
          />
        </label>
        <Button
          variant="ghost"
          size="icon"
          class="h-8 w-8"
          aria-label="Clear formatting"
          onclick={() => editor?.chain().focus().unsetAllMarks().run()}
        >
          <RemoveFormatting class="h-4 w-4" />
        </Button>
      </div>
      <div
        bind:this={editorEl}
        class="signature-editor prose prose-sm dark:prose-invert max-w-none p-3"
      ></div>
    </div>
  {:else}
    <Textarea
      id="signature-textarea"
      value={plainValue}
      oninput={(e) => onPlainInput((e.currentTarget as HTMLTextAreaElement).value)}
      placeholder={'Jane Doe\nForward Email'}
      class="min-h-[120px] font-mono text-sm"
    />
  {/if}
</div>

<style>
  .signature-editor :global(.ProseMirror) {
    min-height: 120px;
    outline: none;
  }
  .signature-editor :global(.ProseMirror a) {
    color: hsl(var(--primary));
    text-decoration: underline;
  }
</style>
