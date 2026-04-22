/**
 * Smart search — natural language → SearchQuery DSL → operator-syntax string.
 *
 * Wraps the ai.worker chat flow for a one-shot JSON translation: collect
 * streamed tokens into a string, parse as JSON, validate against the DSL,
 * convert to the mailbox's existing operator syntax. Result is fed back into
 * `searchStore.actions.search()`.
 *
 * Usage:
 *   const query = await translateSmartSearch('unread from acme last week');
 *   searchStore.actions.search(query.queryString);
 */

import { getAIWorkerClient } from '../utils/ai-worker-client.js';
import { getProvider, getProviderKey } from './keystore-web';
import { getPrompt } from './prompts/system';
import { dslToQueryString, parseSearchQueryJSON, type SearchQuery } from './dsl/search-query';

const PROVIDER_ID = 'anthropic';

export interface SmartSearchResult {
  /** The DSL the model returned, after validation. */
  query: SearchQuery;
  /** Operator-syntax string ready for `searchStore.actions.search()`. */
  queryString: string;
  /** Whatever the model set as `_intent`, or a heuristic derived from the query. */
  intent: string;
}

export class SmartSearchError extends Error {
  readonly code: 'not_configured' | 'invalid_response' | 'model_error';
  constructor(code: SmartSearchError['code'], message: string) {
    super(message);
    this.name = 'SmartSearchError';
    this.code = code;
  }
}

export const translateSmartSearch = async (
  naturalLanguage: string,
  signal?: AbortSignal,
): Promise<SmartSearchResult> => {
  const provider = await getProvider(PROVIDER_ID);
  if (!provider) {
    throw new SmartSearchError('not_configured', 'Configure an Anthropic API key in Settings → AI');
  }
  const apiKey = getProviderKey(PROVIDER_ID);
  if (!apiKey) {
    throw new SmartSearchError('not_configured', 'API key is locked or missing');
  }

  const systemPrompt = getPrompt('smart_search').system;
  const today = new Date().toISOString().slice(0, 10);
  const userMessage = `Today is ${today}. Translate this search request into the SearchQuery JSON schema:\n\n${naturalLanguage.trim()}`;

  const client = getAIWorkerClient();
  let raw = '';
  let errorMsg: string | null = null;

  const handle = client.chat(
    {
      providerConfig: {
        id: PROVIDER_ID,
        kind: 'anthropic',
        endpoint: provider.endpoint,
        model: provider.model,
      },
      apiKey,
      options: {
        model: provider.model ?? 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 512,
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      // Thread scope with null threadId — no tools offered, model only
      // translates the NL into a DSL and returns it.
      context: { kind: 'thread', account: 'smart-search', threadId: null },
    },
    {
      onToken: (t: string) => {
        raw += t;
      },
      onError: (err: { user_message?: string; message?: string }) => {
        errorMsg = err.user_message ?? err.message ?? 'Unknown error';
      },
    },
  );

  if (signal) {
    const cancel = () => handle.cancel();
    signal.addEventListener('abort', cancel, { once: true });
  }

  await handle.finished;

  if (errorMsg) throw new SmartSearchError('model_error', errorMsg);

  const jsonBlock = extractJSON(raw);
  if (!jsonBlock) {
    throw new SmartSearchError(
      'invalid_response',
      'The model did not return a JSON object. Try rephrasing.',
    );
  }

  let query: SearchQuery;
  try {
    query = parseSearchQueryJSON(jsonBlock);
  } catch (err) {
    throw new SmartSearchError(
      'invalid_response',
      err instanceof Error ? err.message : String(err),
    );
  }

  const queryString = dslToQueryString(query);
  const intent =
    query._intent?.trim() ??
    (queryString ? `Translated to: ${queryString}` : 'No constraints extracted');

  return { query, queryString, intent };
};

/**
 * Strip code fences and extract the first top-level JSON object from raw
 * model output. Some models wrap JSON in ```json fences despite being asked
 * for raw output; tolerate that.
 */
const extractJSON = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith('{')) return inner;
  }

  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open !== -1 && close > open) return trimmed.slice(open, close + 1);

  return null;
};
