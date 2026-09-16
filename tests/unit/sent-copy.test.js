import { describe, it, expect, vi } from 'vitest';
import { writable } from 'svelte/store';

vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/storage.js', () => ({ Local: { get: vi.fn(() => null) } }));
vi.mock('../../src/utils/db', () => ({ db: { folders: { where: vi.fn() } } }));
vi.mock('../../src/stores/folderStore.ts', () => ({ folders: writable([]) }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/utils/sent-folder.js', () => ({
  resolveSentFolder: vi.fn(() => 'RESOLVED_FALLBACK'),
}));

import { buildSentCopyPayload, buildOptimisticSentSource } from '../../src/utils/sent-copy.js';
import { resolveSentFolder } from '../../src/utils/sent-folder.js';

describe('buildSentCopyPayload', () => {
  const baseEmail = {
    from: 'me@example.com',
    to: ['you@example.com'],
    subject: 'Hi',
    html: '<p>Body</p>',
    text: 'Body',
  };

  it('uses sentFolderOverride and skips folder resolution when provided', () => {
    const payload = buildSentCopyPayload(baseEmail, 'me@example.com', null, 'Custom/Sent');
    expect(payload.folder).toBe('Custom/Sent');
    expect(resolveSentFolder).not.toHaveBeenCalled();
  });

  it('falls back to resolveSentFolder when no override is given', () => {
    const payload = buildSentCopyPayload(baseEmail, 'me@example.com', null, null);
    expect(payload.folder).toBe('RESOLVED_FALLBACK');
    expect(resolveSentFolder).toHaveBeenCalled();
  });

  it('carries attachments through to the sent copy', () => {
    const attachments = [
      {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        content: 'base64data',
        encoding: 'base64',
      },
    ];
    const payload = buildSentCopyPayload(
      { ...baseEmail, attachments, has_attachment: true },
      'me@example.com',
      null,
      'Sent',
    );
    expect(payload.attachments).toEqual(attachments);
    expect(payload.has_attachment).toBe(true);
  });

  it('defaults attachments to an empty array and has_attachment to false', () => {
    const payload = buildSentCopyPayload(baseEmail, 'me@example.com', null, 'Sent');
    expect(payload.attachments).toEqual([]);
    expect(payload.has_attachment).toBe(false);
  });
});

describe('buildOptimisticSentSource', () => {
  const email = {
    from: 'me@example.com',
    to: ['you@example.com'],
    cc: ['cc@example.com'],
    subject: 'Hi',
    html: '<p>Body</p>',
    text: 'Body',
  };

  it('merges the server id/date with the compose payload', () => {
    const src = buildOptimisticSentSource(email, {
      id: 'srv-123',
      uid: 7,
      created_at: '2026-06-15T12:00:00Z',
    });
    expect(src).toMatchObject({
      id: 'srv-123',
      uid: 7,
      created_at: '2026-06-15T12:00:00Z',
      from: 'me@example.com',
      to: ['you@example.com'],
      cc: ['cc@example.com'],
      subject: 'Hi',
      flags: ['\\Seen'],
    });
  });

  it('returns null when the response carries no id (falls back to sync-only)', () => {
    expect(buildOptimisticSentSource(email, {})).toBeNull();
    expect(buildOptimisticSentSource(email, null)).toBeNull();
  });

  it('accepts an id from alternate response shapes (Id / data.id)', () => {
    expect(buildOptimisticSentSource(email, { Id: 'cap-id' })?.id).toBe('cap-id');
    expect(buildOptimisticSentSource(email, { data: { id: 'nested-id' } })?.id).toBe('nested-id');
  });

  it('derives has_attachment from the attachments array but drops the content', () => {
    const src = buildOptimisticSentSource(
      { ...email, attachments: [{ filename: 'a.pdf', content: 'base64' }] },
      { id: 'x' },
    );
    expect(src.has_attachment).toBe(true);
    // Attachment content is intentionally not carried in the optimistic envelope.
    expect(src.attachments).toBeUndefined();
  });
});

describe('buildOptimisticSentSource reply headers', () => {
  it('keeps inReplyTo and references so the reply index sees the just-sent reply', () => {
    const src = buildOptimisticSentSource(
      {
        from: 'me@example.com',
        to: ['you@example.com'],
        subject: 'Re: Hi',
        inReplyTo: '<orig@example.com>',
        references: '<root@example.com> <orig@example.com>',
      },
      { id: 'sent-1' },
    );
    expect(src.inReplyTo).toBe('<orig@example.com>');
    expect(src.references).toBe('<root@example.com> <orig@example.com>');
  });

  it('defaults references to an empty string for a fresh message', () => {
    const src = buildOptimisticSentSource({ from: 'me@example.com' }, { id: 'sent-2' });
    expect(src.inReplyTo).toBeUndefined();
    expect(src.references).toBe('');
  });
});
