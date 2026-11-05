/**
 * The list paperclip read only `attachments`, `has_attachments` and
 * `attachment_count`. List rows carry none of those: a synced message says
 * `has_attachment` and a conversation `hasAttachment`, so the icon never
 * showed in the message list.
 */
import { describe, expect, it } from 'vitest';
import { filterDownloadableAttachments, hasAttachments } from '../../src/utils/attachment-flags';

describe('hasAttachments', () => {
  it('reads the flag a synced message row carries', () => {
    expect(hasAttachments({ id: 'm1', has_attachment: true })).toBe(true);
    expect(hasAttachments({ id: 'm1', has_attachment: 1 })).toBe(true);
    expect(hasAttachments({ id: 'm1', has_attachment: '1' })).toBe(true);
    expect(hasAttachments({ id: 'm1', has_attachment: false })).toBe(false);
    expect(hasAttachments({ id: 'm1', has_attachment: 0 })).toBe(false);
  });

  it('reads the flag a conversation carries', () => {
    expect(hasAttachments({ id: 'c1', hasAttachment: true, messages: [] })).toBe(true);
    expect(hasAttachments({ id: 'c1', hasAttachment: false, messages: [] })).toBe(false);
  });

  it('finds an attachment in any message of a conversation', () => {
    const conv = { id: 'c1', messages: [{ id: 'm1' }, { id: 'm2', has_attachment: true }] };
    expect(hasAttachments(conv)).toBe(true);
  });

  it('leaves out a signature logo when the full list is known', () => {
    const logo = {
      contentId: 'logo@example.test',
      contentType: 'image/png',
      disposition: 'inline',
    };
    expect(hasAttachments({ id: 'm1', attachments: [logo] })).toBe(false);
    expect(hasAttachments({ id: 'm1', attachments: [logo, { filename: 'a.pdf' }] })).toBe(true);
    expect(filterDownloadableAttachments([logo, { filename: 'a.pdf' }])).toEqual([
      { filename: 'a.pdf' },
    ]);
  });
});
