/**
 * Forward Email – Demo Account Data Generator
 *
 * Provides realistic fake email, contact, and calendar data for the
 * demo account experience. All data is generated deterministically
 * so the demo feels consistent across page reloads.
 *
 * No real API calls are made — everything is served from memory.
 */

// ── Demo Account Constants ────────────────────────────────────────────────
export const DEMO_EMAIL = 'demo@forwardemail.net';
export const DEMO_ALIAS_AUTH = 'demo@forwardemail.net:demo-password-not-real';
export const DEMO_STORAGE_KEY = 'fe_demo_mode';

// ── Helpers ───────────────────────────────────────────────────────────────

// Use deterministic IDs so demo data is consistent across calls
let _idCounter = 0;
function nextId(prefix = 'demo') {
  _idCounter += 1;
  return `${prefix}-${_idCounter}`;
}

// Reset counter before each generator call for deterministic output
function resetIds() {
  _idCounter = 0;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function hoursAgo(n) {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d.toISOString();
}

function minutesAgo(n) {
  const d = new Date();
  d.setMinutes(d.getMinutes() - n);
  return d.toISOString();
}

// ── Fake Folders ──────────────────────────────────────────────────────────

export function generateFolders() {
  return [
    {
      id: 'folder-inbox',
      path: 'INBOX',
      name: 'Inbox',
      delimiter: '/',
      specialUse: '\\Inbox',
      messages: 12,
      unseen: 3,
    },
    {
      id: 'folder-drafts',
      path: 'Drafts',
      name: 'Drafts',
      delimiter: '/',
      specialUse: '\\Drafts',
      messages: 1,
      unseen: 0,
    },
    {
      id: 'folder-sent',
      path: 'Sent',
      name: 'Sent',
      delimiter: '/',
      specialUse: '\\Sent',
      messages: 5,
      unseen: 0,
    },
    {
      id: 'folder-spam',
      path: 'Spam',
      name: 'Spam',
      delimiter: '/',
      specialUse: '\\Junk',
      messages: 2,
      unseen: 1,
    },
    {
      id: 'folder-trash',
      path: 'Trash',
      name: 'Trash',
      delimiter: '/',
      specialUse: '\\Trash',
      messages: 1,
      unseen: 0,
    },
    {
      id: 'folder-archive',
      path: 'Archive',
      name: 'Archive',
      delimiter: '/',
      specialUse: '\\Archive',
      messages: 3,
      unseen: 0,
    },
  ];
}

// ── Fake Messages ─────────────────────────────────────────────────────────

export function generateMessages(folder = 'INBOX', page = 1) {
  resetIds();
  const allMessages = {
    INBOX: [
      {
        id: nextId(),
        uid: 1001,
        mailbox: 'INBOX',
        subject: 'Welcome to Forward Email!',
        from: { name: 'Forward Email Team', address: 'team@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: minutesAgo(5),
        intro:
          'Thanks for trying out Forward Email webmail. This is a demo account with sample data...',
        text: 'Thanks for trying out Forward Email webmail.\n\nThis is a demo account with sample data to help you explore the interface. Feel free to click around and explore all the features!\n\nNote: Sending emails and other write operations are disabled in demo mode.\n\nTo get started with your own account, visit https://forwardemail.net\n\nBest regards,\nThe Forward Email Team',
        html: '<p>Thanks for trying out Forward Email webmail.</p><p>This is a demo account with sample data to help you explore the interface. Feel free to click around and explore all the features!</p><p><strong>Note:</strong> Sending emails and other write operations are disabled in demo mode.</p><p>To get started with your own account, visit <a href="https://forwardemail.net">forwardemail.net</a></p><p>Best regards,<br>The Forward Email Team</p>',
        flags: [],
        size: 2048,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1002,
        mailbox: 'INBOX',
        subject: 'Your weekly privacy report',
        from: { name: 'Privacy Monitor', address: 'privacy@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: hoursAgo(2),
        intro: 'Your email privacy score this week is 98/100. No tracking pixels were detected...',
        text: 'Your email privacy score this week is 98/100.\n\nNo tracking pixels were detected in your incoming emails this week. Forward Email automatically strips tracking pixels and protects your privacy.\n\nPrivacy Summary:\n- Emails received: 47\n- Tracking pixels blocked: 12\n- External images proxied: 23\n- Encrypted emails: 8\n\nKeep up the great work protecting your privacy!',
        html: '<h2>Your Weekly Privacy Report</h2><p>Your email privacy score this week is <strong>98/100</strong>.</p><p>No tracking pixels were detected in your incoming emails this week. Forward Email automatically strips tracking pixels and protects your privacy.</p><h3>Privacy Summary</h3><ul><li>Emails received: 47</li><li>Tracking pixels blocked: 12</li><li>External images proxied: 23</li><li>Encrypted emails: 8</li></ul><p>Keep up the great work protecting your privacy!</p>',
        flags: [],
        size: 3200,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1003,
        mailbox: 'INBOX',
        subject: 'Meeting tomorrow at 2pm',
        from: { name: 'Alice Johnson', address: 'alice@example.com' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: hoursAgo(6),
        intro: 'Hi! Just a reminder about our meeting tomorrow at 2pm. We will be discussing...',
        text: "Hi!\n\nJust a reminder about our meeting tomorrow at 2pm. We will be discussing the Q4 roadmap and feature priorities.\n\nPlease bring your notes from last week's brainstorming session.\n\nSee you there!\nAlice",
        html: "<p>Hi!</p><p>Just a reminder about our meeting tomorrow at 2pm. We will be discussing the Q4 roadmap and feature priorities.</p><p>Please bring your notes from last week's brainstorming session.</p><p>See you there!<br>Alice</p>",
        flags: [],
        size: 1500,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1004,
        mailbox: 'INBOX',
        subject: 'Invoice #2024-0892',
        from: { name: 'Billing Department', address: 'billing@example-corp.com' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(1),
        intro: 'Please find attached your invoice for November 2024. Total amount due: $49.99...',
        text: 'Please find attached your invoice for November 2024.\n\nTotal amount due: $49.99\nDue date: December 15, 2024\n\nPayment methods accepted: Credit card, bank transfer, or PayPal.\n\nThank you for your business!\nBilling Department',
        html: '<p>Please find attached your invoice for November 2024.</p><p><strong>Total amount due:</strong> $49.99<br><strong>Due date:</strong> December 15, 2024</p><p>Payment methods accepted: Credit card, bank transfer, or PayPal.</p><p>Thank you for your business!<br>Billing Department</p>',
        flags: ['\\Seen'],
        size: 4500,
        attachments: [
          { filename: 'invoice-2024-0892.pdf', contentType: 'application/pdf', size: 45000 },
        ],
      },
      {
        id: nextId(),
        uid: 1005,
        mailbox: 'INBOX',
        subject: 'Re: Project update',
        from: { name: 'Bob Smith', address: 'bob@example.org' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(1),
        intro:
          'Great progress on the frontend! The new dashboard looks amazing. I have a few suggestions...',
        text: 'Great progress on the frontend! The new dashboard looks amazing.\n\nI have a few suggestions:\n1. Add dark mode support\n2. Improve the mobile layout\n3. Add keyboard shortcuts\n\nLet me know what you think.\n\nBob',
        html: '<p>Great progress on the frontend! The new dashboard looks amazing.</p><p>I have a few suggestions:</p><ol><li>Add dark mode support</li><li>Improve the mobile layout</li><li>Add keyboard shortcuts</li></ol><p>Let me know what you think.</p><p>Bob</p>',
        flags: ['\\Seen'],
        size: 1800,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1006,
        mailbox: 'INBOX',
        subject: 'Open source contribution accepted!',
        from: { name: 'GitHub', address: 'noreply@github.com' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(2),
        intro:
          'Your pull request #347 has been merged into main. Thank you for your contribution...',
        text: 'Your pull request #347 has been merged into main.\n\nThank you for your contribution to forwardemail/forwardemail.net!\n\nChanges merged:\n- Fixed email parsing edge case\n- Added unit tests for MIME boundary detection\n- Updated documentation\n\nKeep up the great work!',
        html: '<p>Your pull request <strong>#347</strong> has been merged into main.</p><p>Thank you for your contribution to <code>forwardemail/forwardemail.net</code>!</p><h3>Changes merged:</h3><ul><li>Fixed email parsing edge case</li><li>Added unit tests for MIME boundary detection</li><li>Updated documentation</li></ul><p>Keep up the great work!</p>',
        flags: ['\\Seen'],
        size: 2200,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1007,
        mailbox: 'INBOX',
        subject: 'Weekend hiking trip',
        from: { name: 'Carol Davis', address: 'carol@example.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(2),
        intro:
          'Hey! Are you still up for the hiking trip this weekend? The weather forecast looks great...',
        text: 'Hey!\n\nAre you still up for the hiking trip this weekend? The weather forecast looks great for Saturday.\n\nTrail: Mountain View Loop\nMeeting point: Trailhead parking lot\nTime: 8:00 AM\n\nBring water and snacks. I will bring the trail map.\n\nLet me know!\nCarol',
        html: '<p>Hey!</p><p>Are you still up for the hiking trip this weekend? The weather forecast looks great for Saturday.</p><p><strong>Trail:</strong> Mountain View Loop<br><strong>Meeting point:</strong> Trailhead parking lot<br><strong>Time:</strong> 8:00 AM</p><p>Bring water and snacks. I will bring the trail map.</p><p>Let me know!<br>Carol</p>',
        flags: ['\\Seen'],
        size: 1600,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1008,
        mailbox: 'INBOX',
        subject: 'Security alert: New sign-in detected',
        from: { name: 'Forward Email Security', address: 'security@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(3),
        intro: 'A new sign-in to your account was detected from a new device...',
        text: 'A new sign-in to your account was detected.\n\nDevice: Chrome on macOS\nLocation: San Francisco, CA\nTime: November 12, 2024 at 3:45 PM PST\n\nIf this was you, no action is needed.\nIf you did not sign in, please change your password immediately.',
        html: '<p>A new sign-in to your account was detected.</p><p><strong>Device:</strong> Chrome on macOS<br><strong>Location:</strong> San Francisco, CA<br><strong>Time:</strong> November 12, 2024 at 3:45 PM PST</p><p>If this was you, no action is needed.<br>If you did not sign in, please change your password immediately.</p>',
        flags: ['\\Seen'],
        size: 1900,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1009,
        mailbox: 'INBOX',
        subject: 'Newsletter: Privacy tips for 2024',
        from: { name: 'Privacy Weekly', address: 'newsletter@privacyweekly.example' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(4),
        intro:
          'This week we cover the top 10 privacy tools for 2024, including email encryption...',
        text: 'This week we cover the top 10 privacy tools for 2024.\n\n1. Forward Email - Privacy-focused email forwarding\n2. Signal - Encrypted messaging\n3. Tor Browser - Anonymous browsing\n4. ProtonVPN - Secure VPN\n5. Bitwarden - Password manager\n\nRead more at our website.',
        html: '<h2>Privacy Tips for 2024</h2><p>This week we cover the top 10 privacy tools for 2024.</p><ol><li><strong>Forward Email</strong> - Privacy-focused email forwarding</li><li><strong>Signal</strong> - Encrypted messaging</li><li><strong>Tor Browser</strong> - Anonymous browsing</li><li><strong>ProtonVPN</strong> - Secure VPN</li><li><strong>Bitwarden</strong> - Password manager</li></ol><p>Read more at our website.</p>',
        flags: ['\\Seen'],
        size: 5600,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1010,
        mailbox: 'INBOX',
        subject: 'Lunch next week?',
        from: { name: 'Dave Wilson', address: 'dave@example.com' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(5),
        intro: 'Hey, it has been a while! Want to grab lunch next Tuesday or Wednesday?',
        text: 'Hey, it has been a while!\n\nWant to grab lunch next Tuesday or Wednesday? I know a great new Thai place downtown.\n\nLet me know what works for you.\n\nDave',
        html: '<p>Hey, it has been a while!</p><p>Want to grab lunch next Tuesday or Wednesday? I know a great new Thai place downtown.</p><p>Let me know what works for you.</p><p>Dave</p>',
        flags: ['\\Seen'],
        size: 1200,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1011,
        mailbox: 'INBOX',
        subject: 'Your DNS records are configured correctly',
        from: { name: 'Forward Email', address: 'support@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(7),
        intro:
          'Great news! Your DNS records for example.com have been verified and are working correctly...',
        text: 'Great news! Your DNS records for example.com have been verified and are working correctly.\n\nMX records: OK\nSPF record: OK\nDKIM record: OK\nDMARC record: OK\n\nYour email forwarding is fully operational.',
        html: '<p>Great news! Your DNS records for example.com have been verified and are working correctly.</p><ul><li><strong>MX records:</strong> OK</li><li><strong>SPF record:</strong> OK</li><li><strong>DKIM record:</strong> OK</li><li><strong>DMARC record:</strong> OK</li></ul><p>Your email forwarding is fully operational.</p>',
        flags: ['\\Seen'],
        size: 1700,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 1012,
        mailbox: 'INBOX',
        subject: 'Book recommendation: Permanent Record',
        from: { name: 'Eve Martinez', address: 'eve@example.org' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(10),
        intro: 'Just finished reading Permanent Record by Edward Snowden. Highly recommend it...',
        text: 'Just finished reading Permanent Record by Edward Snowden. Highly recommend it if you are interested in privacy and surveillance.\n\nIt really changed my perspective on digital privacy.\n\nEve',
        html: '<p>Just finished reading <em>Permanent Record</em> by Edward Snowden. Highly recommend it if you are interested in privacy and surveillance.</p><p>It really changed my perspective on digital privacy.</p><p>Eve</p>',
        flags: ['\\Seen'],
        size: 1100,
        attachments: [],
      },
    ],
    Sent: [
      {
        id: nextId(),
        uid: 2001,
        mailbox: 'Sent',
        subject: 'Re: Meeting tomorrow at 2pm',
        from: { name: 'Demo User', address: DEMO_EMAIL },
        to: [{ name: 'Alice Johnson', address: 'alice@example.com' }],
        date: hoursAgo(5),
        intro: 'Sounds good! I will be there with my notes. See you at 2pm.',
        text: 'Sounds good! I will be there with my notes. See you at 2pm.\n\nBest,\nDemo User',
        html: '<p>Sounds good! I will be there with my notes. See you at 2pm.</p><p>Best,<br>Demo User</p>',
        flags: ['\\Seen'],
        size: 800,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 2002,
        mailbox: 'Sent',
        subject: 'Re: Project update',
        from: { name: 'Demo User', address: DEMO_EMAIL },
        to: [{ name: 'Bob Smith', address: 'bob@example.org' }],
        date: daysAgo(1),
        intro: 'Thanks for the feedback! I will work on dark mode this week.',
        text: 'Thanks for the feedback! I will work on dark mode this week.\n\nThe keyboard shortcuts are a great idea too.\n\nBest,\nDemo User',
        html: '<p>Thanks for the feedback! I will work on dark mode this week.</p><p>The keyboard shortcuts are a great idea too.</p><p>Best,<br>Demo User</p>',
        flags: ['\\Seen'],
        size: 900,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 2003,
        mailbox: 'Sent',
        subject: 'Re: Weekend hiking trip',
        from: { name: 'Demo User', address: DEMO_EMAIL },
        to: [{ name: 'Carol Davis', address: 'carol@example.net' }],
        date: daysAgo(2),
        intro: 'Count me in! I will bring extra water bottles.',
        text: 'Count me in! I will bring extra water bottles.\n\nSee you Saturday at 8am!\n\nBest,\nDemo User',
        html: '<p>Count me in! I will bring extra water bottles.</p><p>See you Saturday at 8am!</p><p>Best,<br>Demo User</p>',
        flags: ['\\Seen'],
        size: 750,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 2004,
        mailbox: 'Sent',
        subject: 'Re: Lunch next week?',
        from: { name: 'Demo User', address: DEMO_EMAIL },
        to: [{ name: 'Dave Wilson', address: 'dave@example.com' }],
        date: daysAgo(4),
        intro: 'Tuesday works great for me! Let us meet at noon.',
        text: 'Tuesday works great for me! Let us meet at noon.\n\nSend me the address of the Thai place.\n\nBest,\nDemo User',
        html: '<p>Tuesday works great for me! Let us meet at noon.</p><p>Send me the address of the Thai place.</p><p>Best,<br>Demo User</p>',
        flags: ['\\Seen'],
        size: 800,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 2005,
        mailbox: 'Sent',
        subject: 'Re: Book recommendation: Permanent Record',
        from: { name: 'Demo User', address: DEMO_EMAIL },
        to: [{ name: 'Eve Martinez', address: 'eve@example.org' }],
        date: daysAgo(9),
        intro: 'Thanks for the recommendation! I just ordered it.',
        text: 'Thanks for the recommendation! I just ordered it.\n\nI have been meaning to read more about digital privacy.\n\nBest,\nDemo User',
        html: '<p>Thanks for the recommendation! I just ordered it.</p><p>I have been meaning to read more about digital privacy.</p><p>Best,<br>Demo User</p>',
        flags: ['\\Seen'],
        size: 850,
        attachments: [],
      },
    ],
    Drafts: [
      {
        id: nextId(),
        uid: 3001,
        mailbox: 'Drafts',
        subject: 'Blog post draft: Why email privacy matters',
        from: { name: 'Demo User', address: DEMO_EMAIL },
        to: [],
        date: daysAgo(1),
        intro: "In today's digital age, email privacy is more important than ever...",
        text: "In today's digital age, email privacy is more important than ever.\n\n[Draft in progress...]",
        html: "<p>In today's digital age, email privacy is more important than ever.</p><p><em>[Draft in progress...]</em></p>",
        flags: ['\\Seen', '\\Draft'],
        size: 600,
        attachments: [],
      },
    ],
    Spam: [
      {
        id: nextId(),
        uid: 4001,
        mailbox: 'Spam',
        subject: 'You have won $1,000,000!!!',
        from: { name: 'Prize Center', address: 'winner@spam-example.com' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(1),
        intro: 'Congratulations! You have been selected as our lucky winner...',
        text: 'Congratulations! You have been selected as our lucky winner. Click here to claim your prize.',
        html: '<p><strong>Congratulations!</strong> You have been selected as our lucky winner. Click here to claim your prize.</p>',
        flags: [],
        size: 900,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 4002,
        mailbox: 'Spam',
        subject: 'Limited time offer - 90% off',
        from: { name: 'Deals Store', address: 'deals@spam-example.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(3),
        intro: 'Unbelievable deals await! Shop now before it is too late...',
        text: 'Unbelievable deals await! Shop now before it is too late.',
        html: '<p>Unbelievable deals await! Shop now before it is too late.</p>',
        flags: ['\\Seen'],
        size: 1200,
        attachments: [],
      },
    ],
    Trash: [
      {
        id: nextId(),
        uid: 5001,
        mailbox: 'Trash',
        subject: 'Old newsletter subscription',
        from: { name: 'Old Newsletter', address: 'news@old-example.com' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(14),
        intro: 'This month in tech news...',
        text: 'This month in tech news... [deleted content]',
        html: '<p>This month in tech news... [deleted content]</p>',
        flags: ['\\Seen', '\\Deleted'],
        size: 3200,
        attachments: [],
      },
    ],
    Archive: [
      {
        id: nextId(),
        uid: 6001,
        mailbox: 'Archive',
        subject: 'Account setup complete',
        from: { name: 'Forward Email', address: 'noreply@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(30),
        intro: 'Your Forward Email account has been set up successfully...',
        text: 'Your Forward Email account has been set up successfully.\n\nYou can now receive and send emails using your custom domain.',
        html: '<p>Your Forward Email account has been set up successfully.</p><p>You can now receive and send emails using your custom domain.</p>',
        flags: ['\\Seen'],
        size: 1400,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 6002,
        mailbox: 'Archive',
        subject: 'Welcome to Forward Email',
        from: { name: 'Forward Email Team', address: 'team@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(31),
        intro: 'Welcome! We are excited to have you on board...',
        text: 'Welcome! We are excited to have you on board.\n\nForward Email is the 100% open-source and privacy-focused email service.',
        html: '<p>Welcome! We are excited to have you on board.</p><p>Forward Email is the 100% open-source and privacy-focused email service.</p>',
        flags: ['\\Seen'],
        size: 1500,
        attachments: [],
      },
      {
        id: nextId(),
        uid: 6003,
        mailbox: 'Archive',
        subject: 'DNS verification reminder',
        from: { name: 'Forward Email', address: 'support@forwardemail.net' },
        to: [{ name: 'Demo User', address: DEMO_EMAIL }],
        date: daysAgo(28),
        intro: 'Reminder: Please verify your DNS records to complete setup...',
        text: 'Reminder: Please verify your DNS records to complete setup.\n\nVisit your dashboard to check the status.',
        html: '<p>Reminder: Please verify your DNS records to complete setup.</p><p>Visit your dashboard to check the status.</p>',
        flags: ['\\Seen'],
        size: 1300,
        attachments: [],
      },
    ],
  };

  const msgs = allMessages[folder] || [];
  const pageSize = 20;
  const start = (page - 1) * pageSize;
  return msgs.slice(start, start + pageSize);
}

// ── Fake Contacts ─────────────────────────────────────────────────────────

export function generateContacts() {
  return [
    {
      id: nextId(),
      fn: 'Alice Johnson',
      email: 'alice@example.com',
      tel: '+1-555-0101',
      org: 'Acme Corp',
      updated: daysAgo(2),
    },
    {
      id: nextId(),
      fn: 'Bob Smith',
      email: 'bob@example.org',
      tel: '+1-555-0102',
      org: 'Tech Solutions',
      updated: daysAgo(5),
    },
    {
      id: nextId(),
      fn: 'Carol Davis',
      email: 'carol@example.net',
      tel: '+1-555-0103',
      org: '',
      updated: daysAgo(8),
    },
    {
      id: nextId(),
      fn: 'Dave Wilson',
      email: 'dave@example.com',
      tel: '+1-555-0104',
      org: 'Design Studio',
      updated: daysAgo(10),
    },
    {
      id: nextId(),
      fn: 'Eve Martinez',
      email: 'eve@example.org',
      tel: '+1-555-0105',
      org: 'Privacy First Inc',
      updated: daysAgo(15),
    },
    {
      id: nextId(),
      fn: 'Forward Email Team',
      email: 'team@forwardemail.net',
      tel: '',
      org: 'Forward Email',
      updated: daysAgo(30),
    },
  ];
}

// ── Fake Calendar Events ──────────────────────────────────────────────────

export function generateCalendarEvents() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(14, 0, 0, 0);

  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(12, 0, 0, 0);

  return [
    {
      id: nextId(),
      summary: 'Team Meeting',
      description: 'Discuss Q4 roadmap and feature priorities',
      start: tomorrow.toISOString(),
      end: new Date(tomorrow.getTime() + 3600000).toISOString(),
      location: 'Conference Room A',
      attendees: ['alice@example.com', DEMO_EMAIL],
    },
    {
      id: nextId(),
      summary: 'Lunch with Dave',
      description: 'Thai restaurant downtown',
      start: nextWeek.toISOString(),
      end: new Date(nextWeek.getTime() + 3600000).toISOString(),
      location: 'Thai Palace, 123 Main St',
      attendees: ['dave@example.com', DEMO_EMAIL],
    },
  ];
}

// ── Fake Account Info ─────────────────────────────────────────────────────

export function generateAccountInfo() {
  return {
    id: 'demo-account-id',
    email: DEMO_EMAIL,
    plan: 'enhanced-protection',
    storage_used: 15728640, // ~15 MB
    storage_limit: 10737418240, // 10 GB
    created_at: daysAgo(60),
    locale: 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  };
}

// ── Fake Labels ───────────────────────────────────────────────────────────

export function generateLabels() {
  return [
    { id: nextId(), name: 'Important', color: '#ef4444' },
    { id: nextId(), name: 'Work', color: '#3b82f6' },
    { id: nextId(), name: 'Personal', color: '#22c55e' },
    { id: nextId(), name: 'Finance', color: '#f59e0b' },
  ];
}
