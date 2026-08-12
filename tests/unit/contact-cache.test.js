import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isOnlineMock, localGetMock, metaGetMock, metaPutMock, remoteRequestMock, warnMock } =
  vi.hoisted(() => ({
    isOnlineMock: vi.fn(),
    localGetMock: vi.fn(),
    metaGetMock: vi.fn(),
    metaPutMock: vi.fn(),
    remoteRequestMock: vi.fn(),
    warnMock: vi.fn(),
  }));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      get: (...args) => metaGetMock(...args),
      put: (...args) => metaPutMock(...args),
    },
  },
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: (...args) => localGetMock(...args),
  },
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: (...args) => remoteRequestMock(...args),
  },
}));

vi.mock('../../src/utils/logger.ts', () => ({
  warn: (...args) => warnMock(...args),
}));

vi.mock('../../src/utils/network-status', () => ({
  isOnline: (...args) => isOnlineMock(...args),
}));

import {
  getContacts,
  removeContactFromCache,
  upsertContactInCache,
  upsertMultipleContactsInCache,
} from '../../src/utils/contact-cache.js';

function makeRawContact(index) {
  return {
    id: `contact-${index}`,
    full_name: `Contact ${String(index).padStart(4, '0')}`,
    emails: [{ value: `contact${index}@example.com`, type: 'work' }],
    company: 'Example Co',
  };
}

describe('contact-cache pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    localGetMock.mockImplementation((key) => (key === 'email' ? 'user@example.com' : null));
    isOnlineMock.mockReturnValue(true);
    metaGetMock.mockResolvedValue(null);
    metaPutMock.mockResolvedValue(undefined);
    remoteRequestMock.mockReset();
    warnMock.mockReset();
  });

  it('fetches and caches every contacts page when force refreshing', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => makeRawContact(index + 1));
    const secondPage = Array.from({ length: 254 }, (_, index) => makeRawContact(index + 501));

    remoteRequestMock
      .mockResolvedValueOnce({ contacts: firstPage })
      .mockResolvedValueOnce({ contacts: secondPage });

    const contacts = await getContacts({ forceRefresh: true });

    expect(remoteRequestMock).toHaveBeenCalledTimes(2);
    expect(remoteRequestMock).toHaveBeenNthCalledWith(1, 'Contacts', {
      page: 1,
      limit: 500,
    });
    expect(remoteRequestMock).toHaveBeenNthCalledWith(2, 'Contacts', {
      page: 2,
      limit: 500,
    });
    expect(contacts).toHaveLength(754);
    expect(contacts[0]).toMatchObject({
      id: 'contact-1:contact1@example.com',
      contactId: 'contact-1',
      email: 'contact1@example.com',
      name: 'Contact 0001',
    });
    expect(contacts.at(-1)).toMatchObject({
      id: 'contact-754:contact754@example.com',
      contactId: 'contact-754',
      email: 'contact754@example.com',
      name: 'Contact 0754',
    });
    expect(metaPutMock).toHaveBeenCalledTimes(1);
    expect(metaPutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'contacts_v2_user@example.com',
        value: expect.arrayContaining([
          expect.objectContaining({ id: 'contact-1:contact1@example.com' }),
          expect.objectContaining({ id: 'contact-754:contact754@example.com' }),
        ]),
      }),
    );
    expect(metaPutMock.mock.calls[0][0].value).toHaveLength(754);
  });

  it('returns stale cached contacts immediately and refreshes them with all pages in the background', async () => {
    const staleContacts = [{ id: 'cached-1', email: 'cached@example.com', name: 'Cached Contact' }];
    const firstPage = Array.from({ length: 500 }, (_, index) => makeRawContact(index + 1));
    const secondPage = Array.from({ length: 2 }, (_, index) => makeRawContact(index + 501));

    metaGetMock.mockResolvedValue({
      value: staleContacts,
      updatedAt: Date.now() - 16 * 60 * 1000,
    });
    remoteRequestMock
      .mockResolvedValueOnce({ contacts: firstPage })
      .mockResolvedValueOnce({ contacts: secondPage });

    const contacts = await getContacts();

    expect(contacts).toEqual(staleContacts);

    await vi.waitFor(() => {
      expect(remoteRequestMock).toHaveBeenCalledTimes(2);
      expect(metaPutMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'contacts_v2_user@example.com',
        }),
      );
    });

    expect(remoteRequestMock).toHaveBeenNthCalledWith(1, 'Contacts', {
      page: 1,
      limit: 500,
    });
    expect(remoteRequestMock).toHaveBeenNthCalledWith(2, 'Contacts', {
      page: 2,
      limit: 500,
    });
    expect(metaPutMock.mock.calls.at(-1)[0].value).toHaveLength(502);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('contact-cache multi-address CardDAV support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localGetMock.mockImplementation((key) => (key === 'email' ? 'user@example.com' : null));
    isOnlineMock.mockReturnValue(true);
    metaGetMock.mockResolvedValue(null);
    metaPutMock.mockResolvedValue(undefined);
    remoteRequestMock.mockReset();
    warnMock.mockReset();
  });

  it('indexes every unique email for a contact, including a vCard-only fallback address', async () => {
    remoteRequestMock.mockResolvedValueOnce({
      contacts: [
        {
          id: 'tino',
          full_name: 'Tino Kremer',
          // Some CardDAV clients only expose their primary address through
          // the extracted API index; grouped secondary addresses remain in
          // the original vCard content.
          emails: [
            { value: 'tino@tinokremer.nl', type: 'INTERNET' },
            { value: 'TINO@TINOKREMER.NL', type: 'INTERNET' },
          ],
          content: [
            'BEGIN:VCARD',
            'VERSION:3.0',
            'FN:Tino Kremer',
            'item1.EMAIL;TYPE=WORK:info@tinokremer.nl',
            'item2.EMAIL;TYPE=HOME:family@tinokremer.nl',
            'END:VCARD',
          ].join('\r\n'),
        },
      ],
    });

    const contacts = await getContacts({ forceRefresh: true });

    expect(contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tino:info@tinokremer.nl',
          contactId: 'tino',
          email: 'info@tinokremer.nl',
          name: 'Tino Kremer',
        }),
        expect.objectContaining({
          id: 'tino:tino@tinokremer.nl',
          contactId: 'tino',
          email: 'tino@tinokremer.nl',
          name: 'Tino Kremer',
        }),
        expect.objectContaining({
          id: 'tino:family@tinokremer.nl',
          contactId: 'tino',
          email: 'family@tinokremer.nl',
          name: 'Tino Kremer',
        }),
      ]),
    );
    expect(contacts).toHaveLength(3);
  });

  it('replaces stale secondary-address entries when one contact is updated', async () => {
    metaGetMock.mockResolvedValue({
      value: [
        {
          id: 'tino:tino@tinokremer.nl',
          contactId: 'tino',
          email: 'tino@tinokremer.nl',
          name: 'Old Tino',
        },
        {
          id: 'tino:old@tinokremer.nl',
          contactId: 'tino',
          email: 'old@tinokremer.nl',
          name: 'Old Tino',
        },
        { id: 'other:other@example.com', contactId: 'other', email: 'other@example.com' },
      ],
      updatedAt: Date.now(),
    });

    await upsertContactInCache({
      id: 'tino',
      name: 'Tino Kremer',
      emails: [{ value: 'tino@tinokremer.nl' }, { value: 'info@tinokremer.nl' }],
    });

    const cached = metaPutMock.mock.calls.at(-1)[0].value;
    expect(cached).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: 'tino@tinokremer.nl', name: 'Tino Kremer' }),
        expect.objectContaining({ email: 'info@tinokremer.nl', name: 'Tino Kremer' }),
        expect.objectContaining({ email: 'other@example.com' }),
      ]),
    );
    expect(cached).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ email: 'old@tinokremer.nl' })]),
    );
  });

  it('replaces every address for each contact during a bulk refresh', async () => {
    metaGetMock.mockResolvedValue({
      value: [{ id: 'tino', email: 'old@tinokremer.nl', name: 'Old Tino' }],
      updatedAt: Date.now(),
    });

    await upsertMultipleContactsInCache([
      {
        id: 'tino',
        name: 'Tino Kremer',
        emails: [{ value: 'tino@tinokremer.nl' }, { value: 'info@tinokremer.nl' }],
      },
    ]);

    const cached = metaPutMock.mock.calls.at(-1)[0].value;
    expect(cached).toHaveLength(2);
    expect(cached.map((contact) => contact.email).sort()).toEqual([
      'info@tinokremer.nl',
      'tino@tinokremer.nl',
    ]);
  });
});

describe('contact-cache multi-address deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localGetMock.mockImplementation((key) => (key === 'email' ? 'user@example.com' : null));
    metaPutMock.mockResolvedValue(undefined);
  });

  it('removes every cached address for the deleted CardDAV contact', async () => {
    metaGetMock.mockResolvedValue({
      value: [
        {
          id: 'tino:tino@tinokremer.nl',
          contactId: 'tino',
          email: 'tino@tinokremer.nl',
        },
        {
          id: 'tino:info@tinokremer.nl',
          contactId: 'tino',
          email: 'info@tinokremer.nl',
        },
        {
          id: 'other:other@example.com',
          contactId: 'other',
          email: 'other@example.com',
        },
      ],
      updatedAt: Date.now(),
    });

    await removeContactFromCache('tino');

    expect(metaPutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'contacts_v2_user@example.com',
        value: [
          expect.objectContaining({
            contactId: 'other',
            email: 'other@example.com',
          }),
        ],
      }),
    );
  });
});
