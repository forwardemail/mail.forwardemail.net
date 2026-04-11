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

import { getContacts } from '../../src/utils/contact-cache.js';

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
      id: 'contact-1',
      email: 'contact1@example.com',
      name: 'Contact 0001',
    });
    expect(contacts.at(-1)).toMatchObject({
      id: 'contact-754',
      email: 'contact754@example.com',
      name: 'Contact 0754',
    });
    expect(metaPutMock).toHaveBeenCalledTimes(1);
    expect(metaPutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'contacts_user@example.com',
        value: expect.arrayContaining([
          expect.objectContaining({ id: 'contact-1' }),
          expect.objectContaining({ id: 'contact-754' }),
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
          key: 'contacts_user@example.com',
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
