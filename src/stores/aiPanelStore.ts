/**
 * AI Panel Intent Store
 *
 * Lets UI surfaces outside the AskAIPanel (message action bar, keyboard
 * shortcuts, context menus) request that the panel open, optionally with a
 * preset pre-applied ("Draft reply", "Draft w/ code", etc.). The panel
 * subscribes and acts on the intent, then clears it.
 *
 * Keeping this as a store rather than a prop lets any component trigger the
 * panel without threading callbacks through Mailbox.svelte.
 */

import { writable } from 'svelte/store';

export type AIPanelPreset = 'summarize' | 'draft_reply' | 'draft_with_code' | 'ask';

export interface AIPanelIntent {
  /** Monotonic counter so repeated intents with the same preset still fire. */
  nonce: number;
  preset?: AIPanelPreset;
}

const intent = writable<AIPanelIntent | null>(null);
let nonce = 0;

export const aiPanelIntent = { subscribe: intent.subscribe };

/** Request the panel open. Optionally pre-apply a preset. */
export const openAIPanel = (preset?: AIPanelPreset): void => {
  nonce += 1;
  intent.set({ nonce, preset });
};

/** Called by the panel after consuming the intent. */
export const consumeAIPanelIntent = (): void => {
  intent.set(null);
};
