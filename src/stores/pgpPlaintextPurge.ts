/**
 * Remove decrypted PGP plaintext this device saved to disk while it is not
 * allowed there (App Lock off, see pgp-plaintext-policy.ts).
 *
 * Builds before that policy saved it whenever a message was decrypted, and
 * turning App Lock off unwraps the encrypted cache back to plaintext. Each
 * account is cleaned once per "epoch": the epoch goes up when App Lock is
 * turned off, so every account is cleaned again on its next start.
 */
import { forgetPgpPlaintext } from './mailService';
import { searchStore } from './searchStore';
import { Local } from '../utils/storage.js';
import { pgpPlaintextMayPersist } from '../utils/pgp-plaintext-policy';

const EPOCH_KEY = 'pgp_plaintext_purge_epoch';
const doneKey = (account: string) => `pgp_plaintext_purged_${account}`;

const currentEpoch = () => Local.get(EPOCH_KEY) || '1';

let queue: Promise<void> = Promise.resolve();

/** Clean `account` if it has not been cleaned this epoch. One at a time. */
export function purgePgpPlaintextIfNeeded(account: string): Promise<void> {
  const run = async () => {
    if (!account || pgpPlaintextMayPersist()) return;
    const epoch = currentEpoch();
    if (Local.get(doneKey(account)) === epoch) return;
    try {
      const changed = await forgetPgpPlaintext(account);
      // The search index took text from those bodies and subjects
      if (changed.length && account === (Local.get('email') || 'default')) {
        await searchStore.actions.indexMessages(changed);
      }
      Local.set(doneKey(account), epoch);
    } catch (err) {
      console.warn('[pgpPlaintextPurge] could not remove decrypted messages:', err);
    }
  };
  queue = queue.then(run, run);
  return queue;
}

/** App Lock was turned off: every account cleans again, this one now. */
export function pgpPlaintextNoLongerProtected(account: string): Promise<void> {
  Local.set(EPOCH_KEY, String(Number(currentEpoch()) + 1));
  return purgePgpPlaintextIfNeeded(account);
}
