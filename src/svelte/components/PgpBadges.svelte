<script lang="ts">
  /**
   * Encryption and signature badges for a decrypted message.
   *
   * A signature only says something when it checks out against a key the
   * user holds and that key belongs to the address in From. Anything less is
   * shown as less: a valid signature from another address is called out, and
   * a signature from a key the user does not hold says just that.
   */
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import ShieldQuestion from '@lucide/svelte/icons/shield-question';
  import { extractEmail } from '../../utils/address';
  import type { PgpSignatureCheck } from '../../types';

  interface Props {
    encrypted?: boolean;
    signed?: boolean;
    signature?: PgpSignatureCheck | null;
    from?: unknown;
  }

  const { encrypted = false, signed = false, signature = null, from = '' }: Props = $props();

  const sender = $derived(
    extractEmail(from as Parameters<typeof extractEmail>[0])
      .trim()
      .toLowerCase(),
  );

  const view = $derived.by(() => {
    if (signature?.status === 'invalid') {
      return {
        tone: 'danger',
        icon: ShieldAlert,
        label: 'Signature invalid',
        title:
          'The signature does not match this message. It was changed after it was signed, or it was not signed by the key it claims.',
      };
    }
    if (signature?.status === 'revoked') {
      const signers = signature.signers || [];
      return {
        tone: 'caution',
        icon: ShieldAlert,
        label: 'Signing key revoked',
        title: `Signed with a key that ${signers.join(', ') || 'its owner'} has revoked. It can no longer confirm who sent this. Ask the sender for their current key.`,
      };
    }
    if (signature?.status === 'verified') {
      const signers = signature.signers || [];
      if (sender && signers.includes(sender)) {
        return {
          tone: 'success',
          icon: ShieldCheck,
          label: 'Signature verified',
          title: `Signed with the key you hold for ${sender}`,
        };
      }
      return {
        tone: 'caution',
        icon: ShieldAlert,
        label: 'Signed by someone else',
        title: `The signature is valid, but the key belongs to ${signers.join(', ') || 'an unnamed key'}, not ${sender || 'the sender'}.`,
      };
    }
    if (signed || signature?.status === 'unverified') {
      return {
        tone: 'muted',
        icon: ShieldQuestion,
        label: 'Signed, not verified',
        title:
          'The message is signed, but by a key you have not added. Add the sender’s public key under Settings, Privacy & Security to check it.',
      };
    }
    return null;
  });

  const toneClass: Record<string, string> = {
    success: 'border-state-success/25 bg-state-success/10 text-state-success',
    caution: 'border-state-caution/25 bg-state-caution/10 text-state-caution',
    danger: 'border-state-danger/25 bg-state-danger/10 text-state-danger',
    muted: 'border-border bg-muted text-muted-foreground',
  };
</script>

{#if encrypted}
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs {toneClass.success}"
    title="This message was PGP encrypted and decrypted with your key"
    data-testid="pgp-badge-encrypted"
  >
    <LockKeyhole class="h-3 w-3" />
    Encrypted
  </span>
{/if}
{#if view}
  {@const Icon = view.icon}
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs {toneClass[
      view.tone
    ]}"
    title={view.title}
    data-testid="pgp-badge-signature"
    data-signature-status={signature?.status || 'unverified'}
  >
    <Icon class="h-3 w-3" />
    {view.label}
  </span>
{/if}
