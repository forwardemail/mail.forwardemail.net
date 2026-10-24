import { Local } from './storage.js';
import { isMemoryConstrained } from './memory-profile';

// Set once a phone or tablet has had body search switched off by the default
// below. Every load used to write the setting back (setIncludeBody), so a
// stored "true" on a phone that ran an earlier build is that build's default
// (it was on everywhere), not a choice. Once this is set, a stored value is
// the user's own.
export const MOBILE_BODY_INDEXING_RESET_KEY = 'search_body_indexing_mobile_default_v1';

export const resolveSearchBodyIndexing = () => {
  if (isMemoryConstrained && !Local.get(MOBILE_BODY_INDEXING_RESET_KEY)) {
    Local.set(MOBILE_BODY_INDEXING_RESET_KEY, '1');
    Local.set('search_body_indexing', 'false');
    Local.set('include_body', 'false');
    return false;
  }
  const stored = Local.get('search_body_indexing');
  if (stored !== null && stored !== undefined) {
    return stored === 'true' || stored === true;
  }
  const legacy = Local.get('include_body');
  if (legacy !== null && legacy !== undefined) {
    const next = legacy === 'true' || legacy === true;
    Local.set('search_body_indexing', next ? 'true' : 'false');
    return next;
  }
  // Off by default on phones and tablets: body text is most of the index and
  // of every write of it, which took the iOS web content process over its
  // memory limit. Search still covers subject, sender, recipients, preview
  // and labels, and Settings turns body search on.
  return !isMemoryConstrained;
};
