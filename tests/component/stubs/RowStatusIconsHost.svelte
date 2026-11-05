<script lang="ts">
  // A message list row around the status icons: a click that reaches the row
  // opens the message, as in Mailbox.svelte.
  import RowStatusIcons from '../../../src/svelte/components/RowStatusIcons.svelte';
  let { onOpen = () => {}, replied = true, attachments = true } = $props();
  let starred = $state(false);
</script>

<div
  data-testid="message-row"
  role="option"
  aria-selected="false"
  tabindex="0"
  onclick={onOpen}
  onkeydown={() => {}}
>
  <RowStatusIcons {replied} {attachments} {starred} onToggleStar={() => (starred = !starred)} />
</div>
