export const mockFolders = [
  { path: 'INBOX', name: 'Inbox', count: 3, level: 0 },
  { path: 'SENT', name: 'Sent', count: 0, level: 0 },
  { path: 'Drafts', name: 'Drafts', count: 0, level: 0 },
  { path: 'TRASH', name: 'Trash', count: 0, level: 0 },
  { path: 'Archive', name: 'Archive', count: 0, level: 0 },
  { path: 'Spam', name: 'Spam', count: 0, level: 0 },
];

export const mockMessages = [
  {
    Uid: 'msg-1',
    folder: 'INBOX',
    Subject: 'Welcome to Webmail',
    From: { Email: 'team@example.com', Display: 'Team' },
    snippet: 'Thanks for trying the mocked mailbox.',
    Date: new Date().toISOString(),
    flags: [],
    has_attachment: false,
  },
  {
    Uid: 'msg-2',
    folder: 'INBOX',
    Subject: 'Your calendar invite',
    From: { Email: 'calendar@example.com', Display: 'Calendar Bot' },
    snippet: 'You have a meeting scheduled tomorrow.',
    Date: new Date(Date.now() - 3600 * 1000).toISOString(),
    flags: ['\\Seen'],
    has_attachment: true,
  },
  {
    Uid: 'msg-3',
    folder: 'INBOX',
    Subject: 'Starred important message',
    From: { Email: 'boss@example.com', Display: 'Boss' },
    snippet: 'Please review the attached proposal.',
    Date: new Date(Date.now() - 7200 * 1000).toISOString(),
    flags: ['\\Flagged'],
    has_attachment: false,
  },
];

export const mockMessageBodies = {
  'msg-1': {
    html: '<p>Welcome to the mocked inbox. Use keyboard shortcuts to navigate.</p>',
    attachments: [],
  },
  'msg-2': {
    html: '<p>Meeting invite details here.</p>',
    attachments: [{ name: 'invite.ics', size: 1024 }],
  },
};

export const mockContacts = [
  {
    id: 'contact-001',
    full_name: 'Alice Johnson',
    emails: [{ value: 'alice@example.com' }],
    phone_numbers: [{ value: '555-0101' }],
    content: `BEGIN:VCARD
VERSION:3.0
FN:Alice Johnson
EMAIL;TYPE=INTERNET:alice@example.com
TEL:555-0101
ORG:Acme Corp
TITLE:Product Manager
NOTE:VIP client
END:VCARD`,
  },
  {
    id: 'contact-002',
    full_name: 'Bob Smith',
    emails: [{ value: 'bob@example.com' }],
    phone_numbers: [{ value: '555-0102' }],
    content: `BEGIN:VCARD
VERSION:3.0
FN:Bob Smith
EMAIL;TYPE=INTERNET:bob@example.com
TEL:555-0102
NOTE:Partner contact
END:VCARD`,
  },
  {
    id: 'contact-003',
    full_name: 'Carol Williams',
    emails: [{ value: 'carol@techcorp.com' }],
    phone_numbers: [{ value: '555-0103' }],
    content: `BEGIN:VCARD
VERSION:3.0
FN:Carol Williams
EMAIL;TYPE=INTERNET:carol@techcorp.com
TEL:555-0103
ORG:TechCorp
TITLE:Engineering Lead
URL:https://techcorp.com
TZ:America/New_York
BDAY:19850315
NOTE:Met at tech conference 2025
END:VCARD`,
  },
  {
    id: 'contact-004',
    full_name: 'David Chen',
    emails: [{ value: 'david@startup.io' }],
    phone_numbers: [],
    content: `BEGIN:VCARD
VERSION:3.0
FN:David Chen
EMAIL;TYPE=INTERNET:david@startup.io
END:VCARD`,
  },
];

export const mockCalendars = [{ id: 'default', name: 'My Calendar', displayName: 'My Calendar' }];

export const mockEvents = [
  {
    id: 'evt-001',
    uid: 'evt-001',
    calendar_id: 'default',
    summary: 'Morning Standup',
    title: 'Morning Standup',
    start: '2026-01-20T09:00:00.000Z',
    end: '2026-01-20T09:30:00.000Z',
    start_date: '2026-01-20T09:00:00.000Z',
    end_date: '2026-01-20T09:30:00.000Z',
    dtstart: '2026-01-20T09:00:00.000Z',
    dtend: '2026-01-20T09:30:00.000Z',
    description: 'Daily team sync',
    location: '',
    url: '',
    timezone: '',
    attendees: '',
    notify: 0,
    reminder: 0,
  },
  {
    id: 'evt-002',
    uid: 'evt-002',
    calendar_id: 'default',
    summary: 'Client Meeting',
    title: 'Client Meeting',
    start: '2026-01-20T14:00:00.000Z',
    end: '2026-01-20T15:00:00.000Z',
    start_date: '2026-01-20T14:00:00.000Z',
    end_date: '2026-01-20T15:00:00.000Z',
    dtstart: '2026-01-20T14:00:00.000Z',
    dtend: '2026-01-20T15:00:00.000Z',
    description: 'Quarterly review with ABC Corp',
    location: 'Conference Room A',
    url: 'https://zoom.us/j/123456',
    timezone: 'America/New_York',
    attendees: 'client@example.com,manager@example.com',
    notify: 15,
    reminder: 15,
  },
  {
    id: 'evt-003',
    uid: 'evt-003',
    calendar_id: 'default',
    summary: 'Team Building Day',
    title: 'Team Building Day',
    start: '2026-01-25T00:00:00.000Z',
    end: '2026-01-25T23:59:59.999Z',
    start_date: '2026-01-25T00:00:00.000Z',
    end_date: '2026-01-25T23:59:59.999Z',
    dtstart: '2026-01-25T00:00:00.000Z',
    dtend: '2026-01-25T23:59:59.999Z',
    description: 'Annual team building activities',
    location: 'City Park',
    url: '',
    timezone: '',
    attendees: '',
    notify: 0,
    reminder: 0,
  },
];
