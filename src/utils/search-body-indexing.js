import { Local } from './storage.js';
import { isMemoryConstrained } from './memory-profile';

export const resolveSearchBodyIndexing = () => {
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
