/**
 * Account and settings type definitions
 */

export interface Account {
  id: string;
  email: string;
  name?: string;
  provider?: string;
  isAlias?: boolean;
  isPrimary?: boolean;
  avatar?: string;
  signature?: string;
  pgpEnabled?: boolean;
  pgpKeyId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AccountSettings {
  theme: ThemeMode;
  font?: string;
  fontSize?: number;
  compactMode?: boolean;
  showPreview?: boolean;
  previewLines?: number;
  confirmDelete?: boolean;
  confirmArchive?: boolean;
  markReadOnOpen?: boolean;
  markReadDelay?: number;
  defaultReplyAll?: boolean;
  signatureEnabled?: boolean;
  signature?: string;
  loadRemoteImages?: 'always' | 'never' | 'ask';
  pgpEnabled?: boolean;
  pgpKeyId?: string;
  pgpPublicKey?: string;
  autoSaveDrafts?: boolean;
  draftSaveInterval?: number;
  prefetchFolders?: string[];
  notificationsEnabled?: boolean;
  soundEnabled?: boolean;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface Label {
  id: string;
  account: string;
  name: string;
  /** IMAP keyword the label maps to. The settings registry keys on this. */
  keyword?: string;
  /** Registry labels flagged hidden are filtered out of pickers. */
  hidden?: boolean;
  color?: string;
  textColor?: string;
  visible?: boolean;
  order?: number;
  createdAt?: number;
  updatedAt?: number;
  /**
   * True when the label was discovered as an IMAP keyword on a message rather
   * than registered in account settings. Discovered labels are only kept while
   * a message still carries them, so a keyword that is gone server-side does
   * not linger in the filter dropdown.
   */
  discovered?: boolean;
}

export interface Contact {
  id: string;
  account: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  avatar?: string;
  company?: string;
  phone?: string;
  notes?: string;
  groups?: string[];
  isFavorite?: boolean;
  lastContacted?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface ContactGroup {
  id: string;
  account: string;
  name: string;
  color?: string;
  members?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface CalendarEvent {
  id: string;
  account: string;
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  start: string | Date;
  end: string | Date;
  allDay?: boolean;
  recurrence?: string;
  attendees?: EventAttendee[];
  organizer?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  visibility?: 'public' | 'private';
  reminders?: EventReminder[];
  color?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface EventAttendee {
  email: string;
  name?: string;
  status?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  role?: 'required' | 'optional' | 'chair';
}

export interface EventReminder {
  method: 'popup' | 'email';
  minutes: number;
}

export interface PgpKey {
  name: string;
  value: string;
}
