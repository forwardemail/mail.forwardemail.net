<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Unsubscriber } from 'svelte/store';
  import { Remote } from '../utils/remote';
  import { Local } from '../utils/storage';
  import {
    removeContactFromCache,
    upsertContactInCache,
    upsertMultipleContactsInCache,
  } from '../utils/contact-cache';
  import { currentAccount } from '../stores/mailboxActions';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Label } from '$lib/components/ui/label';
  import { Separator } from '$lib/components/ui/separator';
  import * as Card from '$lib/components/ui/card';
  import * as Avatar from '$lib/components/ui/avatar';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Alert from '$lib/components/ui/alert';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Upload from '@lucide/svelte/icons/upload';
  import Camera from '@lucide/svelte/icons/camera';
  import Plus from '@lucide/svelte/icons/plus';
  import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
  import Mail from '@lucide/svelte/icons/mail';
  import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
  import Search from '@lucide/svelte/icons/search';
  import Download from '@lucide/svelte/icons/download';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Info from '@lucide/svelte/icons/info';
  import User from '@lucide/svelte/icons/user';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';

  let accountUnsub: Unsubscriber | null = null;

  interface ToastApi {
    show?: (message: string, type?: string) => void;
  }

  interface ContactsApi {
    open?: () => void;
    refresh?: () => void;
    reload?: () => void;
  }

  interface Contact {
    id: string | null;
    name: string;
    email: string;
    phone: string;
    notes: string;
    company: string;
    jobTitle: string;
    timezone: string;
    website: string;
    birthday: string;
    photo: string;
    raw?: unknown;
  }

  interface Props {
    navigate?: (path: string) => void;
    toasts?: ToastApi | null;
    registerApi?: (api: ContactsApi) => void;
  }

  let { navigate = () => {}, toasts = null, registerApi = () => {} }: Props = $props();

  let contacts = $state<Contact[]>([]);
  let filtered = $state<Contact[]>([]);
  let selectedContact = $state<Contact | null>(null);
  let draft = $state<Contact | null>(null);

  // Detect if draft has unsaved changes compared to selectedContact
  const hasChanges = $derived.by(() => {
    if (!draft || !selectedContact) return false;
    return (
      draft.name !== selectedContact.name ||
      draft.email !== selectedContact.email ||
      draft.phone !== selectedContact.phone ||
      draft.notes !== selectedContact.notes ||
      draft.company !== selectedContact.company ||
      draft.jobTitle !== selectedContact.jobTitle ||
      draft.timezone !== selectedContact.timezone ||
      draft.website !== selectedContact.website ||
      draft.birthday !== selectedContact.birthday ||
      draft.photo !== selectedContact.photo
    );
  });
  let loading = $state(false);
  let error = $state('');
  let query = $state('');
  let modalVisible = $state(false);
  let modalMode = $state<'create' | 'edit'>('create');
  const emptyContact = (): Contact => ({
    id: null,
    name: '',
    email: '',
    phone: '',
    notes: '',
    company: '',
    jobTitle: '',
    timezone: '',
    website: '',
    birthday: '',
    photo: '',
  });

  let modalContact = $state<Contact>(emptyContact());
  let modalSaving = $state(false);
  let modalError = $state('');
  let confirmVisible = $state(false);
  let confirmTarget = $state<Contact | null>(null);
  let optionalFieldsExpanded = $state(false);
  let importMenuOpen = $state(false);
  let lastAccount = Local.get('email') || '';
  let loadRequestId = 0;
  const activeEmail = $derived($currentAccount || Local.get('email') || '');
  const isMobileViewport = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 720px)').matches;

  const maxImageSize = 256;

  const readAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });

  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = src;
    });

  const cropToSquare = (img: HTMLImageElement): string => {
    const size = Math.min(img.width, img.height);
    const sx = Math.floor((img.width - size) / 2);
    const sy = Math.floor((img.height - size) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = maxImageSize;
    canvas.height = maxImageSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(img, sx, sy, size, size, 0, 0, maxImageSize, maxImageSize);
    return canvas.toDataURL('image/png', 0.9);
  };

  const handlePhotoSelect = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toasts?.show?.('Please choose an image file.', 'error');
      target.value = '';
      return;
    }

    try {
      const dataUrl = await readAsDataUrl(file);
      const img = await loadImage(dataUrl);
      const cropped = cropToSquare(img);
      if (!cropped) {
        toasts?.show?.('Unable to process image.', 'error');
      } else if (draft) {
        draft.photo = cropped;
      }
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Unable to upload image.', 'error');
    } finally {
      target.value = '';
    }
  };

  const removePhoto = () => {
    if (draft) {
      draft.photo = '';
    }
  };

  const getInitials = (contact: Contact | null): string => {
    if (!contact) return '';
    const name = contact.name || '';
    const email = contact.email || '';

    if (name.trim()) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      }
      return name.substring(0, 2).toUpperCase();
    }

    if (email) {
      const localPart = email.split('@')[0];
      return localPart.substring(0, 2).toUpperCase();
    }

    return '??';
  };

  const hashCode = (str: string): number => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  };

  const getAvatarColor = (contact: Contact | null): string => {
    const colors = [
      '#3b82f6',
      '#8b5cf6',
      '#ec4899',
      '#f59e0b',
      '#10b981',
      '#06b6d4',
      '#6366f1',
      '#84cc16',
      '#f97316',
      '#14b8a6',
      '#a855f7',
      '#eab308',
    ];
    const email = contact?.email || contact?.id || 'default';
    const hash = hashCode(email);
    return colors[hash % colors.length];
  };

  const generateVCard = (contact: Contact): string => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    if (contact.name) lines.push(`FN:${contact.name}`);
    if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${contact.email}`);
    if (contact.phone) lines.push(`TEL:${contact.phone}`);
    if (contact.company) lines.push(`ORG:${contact.company}`);
    if (contact.jobTitle) lines.push(`TITLE:${contact.jobTitle}`);
    if (contact.website) lines.push(`URL:${contact.website}`);
    if (contact.birthday) lines.push(`BDAY:${contact.birthday.replace(/-/g, '')}`);
    if (contact.timezone) lines.push(`TZ:${contact.timezone}`);
    if (contact.notes) lines.push(`NOTE:${contact.notes.replace(/\n/g, '\\n')}`);
    if (contact.photo) {
      const photoData = contact.photo.replace(/^data:image\/[^;]+;base64,/, '');
      lines.push(`PHOTO;ENCODING=b;TYPE=PNG:${photoData}`);
    }
    lines.push('END:VCARD');
    return lines.join('\r\n');
  };

  interface ParsedVCard {
    name?: string;
    emails: string[];
    phones: string[];
    notes?: string;
    company?: string;
    jobTitle?: string;
    website?: string;
    birthday?: string;
    timezone?: string;
    photo?: string;
    address?: string;
  }

  const parseVCard = (content: string): ParsedVCard => {
    if (!content) return { emails: [], phones: [] };
    const parsed: ParsedVCard = { emails: [], phones: [] };
    const rawLines = content.split(/\r?\n/);
    const lines: string[] = [];
    for (const line of rawLines) {
      if (!line) continue;
      if (/^[ \t]/.test(line) && lines.length) {
        lines[lines.length - 1] += line.trimStart();
      } else {
        lines.push(line);
      }
    }
    const unescapeText = (value: string): string =>
      value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const keyPart = line.slice(0, colonIndex);
      const value = unescapeText(line.slice(colonIndex + 1));
      const key = keyPart.split(';')[0].toUpperCase();

      if (key === 'FN' && !parsed.name) {
        parsed.name = value;
      } else if (key === 'N' && !parsed.name) {
        const [last, first, additional, prefix, suffix] = value.split(';');
        const parts = [prefix, first, additional, last, suffix].filter(Boolean);
        if (parts.length) parsed.name = parts.join(' ').replace(/\s+/g, ' ').trim();
      } else if (key === 'EMAIL') {
        if (value) parsed.emails.push(value);
      } else if (key === 'TEL') {
        if (value) parsed.phones.push(value);
      } else if (key === 'NOTE') {
        parsed.notes = value;
      } else if (key === 'ORG') {
        parsed.company = value;
      } else if (key === 'TITLE') {
        parsed.jobTitle = value;
      } else if (key === 'URL') {
        parsed.website = value;
      } else if (key === 'BDAY') {
        if (value.length === 8) {
          parsed.birthday = `${value.substring(0, 4)}-${value.substring(4, 6)}-${value.substring(6, 8)}`;
        } else {
          parsed.birthday = value;
        }
      } else if (key === 'TZ') {
        parsed.timezone = value;
      } else if (key === 'PHOTO') {
        const typeMatch = keyPart.match(/TYPE=([^;:]+)/i);
        const photoType = typeMatch ? typeMatch[1].toLowerCase() : 'png';
        if (value) {
          parsed.photo = value.startsWith('data:')
            ? value
            : `data:image/${photoType};base64,${value}`;
        }
      } else if (key === 'ADR') {
        parsed.address = value;
      }
    }
    return parsed;
  };

  const exportVCard = (contact: Contact | null) => {
    if (!contact) return;
    const vcardContent = generateVCard(contact);
    const blob = new Blob([vcardContent], { type: 'text/vcard;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = (contact.name || contact.email || 'contact').replace(/[^a-z0-9]/gi, '_');
    a.download = `${filename}.vcf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toasts?.show?.('vCard exported', 'success');
  };

  const importVCard = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;

    const maxSize = 25 * 1024 * 1024; // 25MB to support large backups
    if (file.size > maxSize) {
      toasts?.show?.('File too large. Maximum size is 25MB.', 'error');
      target.value = '';
      return;
    }

    try {
      const content = await file.text();
      const vcards = content.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [];
      if (!vcards.length) {
        toasts?.show?.('No contacts found in vCard file.', 'error');
        return;
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const total = vcards.length;

      // Show progress for large imports
      if (total > 5) {
        toasts?.show?.(`Importing ${total} contacts...`, 'info');
      }

      for (let i = 0; i < vcards.length; i++) {
        const vcardContent = vcards[i];
        const vcardData = parseVCard(vcardContent);
        const email = vcardData.emails?.[0] || '';
        const name = vcardData.name || '';

        // Allow contacts with either email or name (not just email)
        if (!email && !name) {
          skipped++;
          continue;
        }

        try {
          // Match by email if available, otherwise by name
          const existing = email
            ? contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase())
            : contacts.find((c) => c.name?.toLowerCase() === name.toLowerCase() && !c.email);
          const payload = { content: vcardContent };

          if (existing) {
            await Remote.request('ContactsUpdate', payload, {
              method: 'PUT',
              pathOverride: `/v1/contacts/${encodeURIComponent(existing.id || '')}`,
            });
            updated++;
          } else {
            await Remote.request('ContactsCreate', payload, {
              method: 'POST',
              pathOverride: '/v1/contacts',
            });
            imported++;
          }
        } catch {
          // Skip individual contact errors during bulk import
          skipped++;
        }

        // Show progress every 25 contacts for large imports
        if (total > 25 && (i + 1) % 25 === 0) {
          toasts?.show?.(`Imported ${i + 1} of ${total} contacts...`, 'info');
        }
      }

      if (imported + updated > 0) {
        // Reload contacts from API and update cache with the new data
        await load();
        // Surgically update cache with loaded contacts
        upsertMultipleContactsInCache(
          contacts.map((c) => ({
            id: c.id,
            email: c.email,
            name: c.name,
            avatar: c.photo || '',
            company: c.company || '',
          })),
        ).catch(() => {});
      }

      const parts: string[] = [];
      if (imported > 0) parts.push(`imported ${imported}`);
      if (updated > 0) parts.push(`updated ${updated}`);
      if (skipped > 0) parts.push(`skipped ${skipped}`);
      const msg = parts.length > 0 ? `Contacts: ${parts.join(', ')}` : 'No contacts imported';
      toasts?.show?.(msg, imported + updated > 0 ? 'success' : 'info');
    } catch (err) {
      toasts?.show?.(
        'Failed to import vCard: ' + ((err as Error)?.message || 'Unknown error'),
        'error',
      );
    } finally {
      target.value = '';
      importMenuOpen = false;
    }
  };

  const sortByName = (list: Contact[]) =>
    [...list].sort((a, b) => {
      const nameA = (a.name || a.email || '').toLowerCase();
      const nameB = (b.name || b.email || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

  const applyFilter = () => {
    const q = (query || '').toLowerCase();
    if (!q) {
      filtered = sortByName(contacts);
      return;
    }
    filtered = sortByName(
      contacts.filter(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.company && c.company.toLowerCase().includes(q)),
      ),
    );
  };

  const selectContact = (contact: Contact | null) => {
    selectedContact = contact;
    draft = contact ? { ...contact } : null;
    if (contact) {
      optionalFieldsExpanded = !!(
        contact.company ||
        contact.jobTitle ||
        contact.timezone ||
        contact.website ||
        contact.birthday
      );
    }
  };

  const startNew = () => {
    modalMode = 'create';
    modalContact = emptyContact();
    modalError = '';
    modalSaving = false;
    modalVisible = true;
  };

  const cancelEditInline = () => {
    draft = selectedContact ? { ...selectedContact } : null;
  };

  const startMail = (contact: Contact | null) => {
    if (!contact?.email) return;
    navigate?.('/mailbox#compose=' + encodeURIComponent(contact.email));
  };

  const addEvent = (contact: Contact | null) => {
    navigate?.('/calendar#addevent=' + encodeURIComponent(contact?.email || ''));
  };

  const viewEmails = (contact: Contact | null) => {
    navigate?.('/mailbox#search=' + encodeURIComponent(contact?.email || ''));
  };

  const load = async () => {
    const requestId = ++loadRequestId;
    loading = true;
    error = '';
    try {
      const res = await Remote.request('Contacts', { limit: 500 });
      if (requestId !== loadRequestId) return;
      const list = Array.isArray(res)
        ? res
        : (res as { Result?: unknown[]; contacts?: unknown[] })?.Result ||
          (res as { contacts?: unknown[] })?.contacts ||
          [];
      const mapped: Contact[] = (list || []).map((c: Record<string, unknown>) => {
        const vcard = parseVCard(c.content as string);
        return {
          id: (c.id || c.contact_id || c.uid || c.Id) as string,
          name: (c.full_name || c.name || c.FullName || vcard.name || '') as string,
          email:
            (c.emails as { value: string }[])?.[0]?.value ||
            (c.Emails as { value: string }[])?.[0]?.value ||
            (c.email as string) ||
            vcard.emails?.[0] ||
            '',
          phone:
            (c.phone_numbers as { value: string }[])?.[0]?.value ||
            (c.Phones as { value: string }[])?.[0]?.value ||
            (c.phones as { value: string }[])?.[0]?.value ||
            vcard.phones?.[0] ||
            '',
          notes: vcard.notes || '',
          company: vcard.company || '',
          jobTitle: vcard.jobTitle || '',
          timezone: vcard.timezone || '',
          website: vcard.website || '',
          birthday: vcard.birthday || '',
          photo: vcard.photo || '',
          raw: c,
        };
      });
      contacts = mapped;
      applyFilter();
      if (isMobileViewport()) {
        if (selectedContact) selectContact(null);
      } else if (!selectedContact && mapped.length) {
        selectContact(mapped[0]);
      }
    } catch (err) {
      if (requestId !== loadRequestId) return;
      error = (err as Error)?.message || 'Unable to load contacts.';
    } finally {
      if (requestId === loadRequestId) {
        loading = false;
      }
    }
  };

  const resetContactsState = () => {
    loadRequestId += 1;
    contacts = [];
    filtered = [];
    selectedContact = null;
    draft = null;
    loading = false;
    error = '';
    query = '';
    modalVisible = false;
    modalMode = 'create';
    modalContact = emptyContact();
    modalSaving = false;
    modalError = '';
    confirmVisible = false;
    confirmTarget = null;
    optionalFieldsExpanded = false;
    importMenuOpen = false;
  };

  const saveInline = async () => {
    if (!draft) return;
    const name = (draft.name || '').trim();
    const email = (draft.email || '').trim();
    if (!email) {
      error = 'Email is required.';
      return;
    }
    loading = true;
    error = '';
    try {
      const contactData: Contact = {
        id: draft.id,
        name,
        email,
        phone: draft.phone || '',
        notes: draft.notes || '',
        company: draft.company || '',
        jobTitle: draft.jobTitle || '',
        timezone: draft.timezone || '',
        website: draft.website || '',
        birthday: draft.birthday || '',
        photo: draft.photo || '',
      };
      const vCardContent = generateVCard(contactData);
      const payload = {
        full_name: name,
        emails: email ? [{ value: email }] : undefined,
        phone_numbers: draft.phone ? [{ value: draft.phone }] : undefined,
        content: vCardContent,
      };
      if (draft.id) {
        const id = draft.id;
        const updated = (await Remote.request('ContactsUpdate', payload, {
          method: 'PUT',
          pathOverride: `/v1/contacts/${encodeURIComponent(id)}`,
        })) as Record<string, unknown>;
        const vcardData = parseVCard(updated?.content as string);
        contacts = contacts.map((c) =>
          c.id === id
            ? {
                ...c,
                name: (updated?.full_name as string) || name,
                email:
                  (updated?.emails as { value: string }[])?.[0]?.value ||
                  (updated?.email as string) ||
                  email ||
                  '',
                phone:
                  (updated?.phone_numbers as { value: string }[])?.[0]?.value ||
                  (updated?.phone as string) ||
                  draft.phone ||
                  '',
                notes: vcardData.notes || draft.notes || '',
                company: vcardData.company || draft.company || '',
                jobTitle: vcardData.jobTitle || draft.jobTitle || '',
                timezone: vcardData.timezone || draft.timezone || '',
                website: vcardData.website || draft.website || '',
                birthday: vcardData.birthday || draft.birthday || '',
                photo: vcardData.photo || draft.photo || '',
              }
            : c,
        );
        selectedContact = contacts.find((c) => c.id === id) || null;
        draft = selectedContact ? { ...selectedContact } : null;
        toasts?.show?.('Contact updated', 'success');
      } else {
        const created = (await Remote.request('ContactsCreate', payload, {
          method: 'POST',
          pathOverride: '/v1/contacts',
        })) as Record<string, unknown>;
        const vcardData = parseVCard(created?.content as string);
        const mapped: Contact = {
          id: (created?.id || created?.contact_id || created?.uid || created?.Id) as string,
          name: (created?.full_name as string) || name,
          email:
            (created?.emails as { value: string }[])?.[0]?.value ||
            (created?.email as string) ||
            email,
          phone:
            (created?.phone_numbers as { value: string }[])?.[0]?.value ||
            (created?.phone as string) ||
            draft.phone ||
            '',
          notes: vcardData.notes || draft.notes || '',
          company: vcardData.company || draft.company || '',
          jobTitle: vcardData.jobTitle || draft.jobTitle || '',
          timezone: vcardData.timezone || draft.timezone || '',
          website: vcardData.website || draft.website || '',
          birthday: vcardData.birthday || draft.birthday || '',
          photo: vcardData.photo || draft.photo || '',
          raw: created,
        };
        contacts = [mapped, ...contacts];
        selectedContact = mapped;
        draft = { ...mapped };
        toasts?.show?.('Contact created', 'success');
      }
      applyFilter();
      // Surgically update the specific contact in cache
      if (selectedContact) {
        upsertContactInCache({
          id: selectedContact.id,
          email: selectedContact.email,
          name: selectedContact.name,
          avatar: selectedContact.photo || '',
          company: selectedContact.company || '',
        }).catch(() => {});
      }
    } catch (err) {
      error = (err as Error)?.message || 'Unable to save contact.';
    } finally {
      loading = false;
    }
  };

  const saveModal = async () => {
    modalSaving = true;
    modalError = '';
    try {
      const name = (modalContact.name || '').trim();
      const email = (modalContact.email || '').trim();
      if (!email) {
        modalError = 'Email is required.';
        modalSaving = false;
        return;
      }
      const contactData: Contact = {
        id: modalContact.id,
        name,
        email,
        phone: modalContact.phone || '',
        notes: modalContact.notes || '',
        company: modalContact.company || '',
        jobTitle: modalContact.jobTitle || '',
        timezone: modalContact.timezone || '',
        website: modalContact.website || '',
        birthday: modalContact.birthday || '',
        photo: modalContact.photo || '',
      };
      const vCardContent = generateVCard(contactData);
      const payload = {
        full_name: name,
        emails: email ? [{ value: email }] : undefined,
        phone_numbers: modalContact.phone ? [{ value: modalContact.phone }] : undefined,
        content: vCardContent,
      };
      if (modalMode === 'edit' && modalContact.id) {
        const id = modalContact.id;
        const updated = (await Remote.request('ContactsUpdate', payload, {
          method: 'PUT',
          pathOverride: `/v1/contacts/${encodeURIComponent(id)}`,
        })) as Record<string, unknown>;
        const vcardData = parseVCard(updated?.content as string);
        contacts = contacts.map((c) =>
          c.id === id
            ? {
                ...c,
                name: (updated?.full_name as string) || name,
                email:
                  (updated?.emails as { value: string }[])?.[0]?.value ||
                  (updated?.email as string) ||
                  email ||
                  '',
                phone:
                  (updated?.phone_numbers as { value: string }[])?.[0]?.value ||
                  (updated?.phone as string) ||
                  modalContact.phone ||
                  '',
                notes: vcardData.notes || modalContact.notes || '',
                company: vcardData.company || modalContact.company || '',
                jobTitle: vcardData.jobTitle || modalContact.jobTitle || '',
                timezone: vcardData.timezone || modalContact.timezone || '',
                website: vcardData.website || modalContact.website || '',
                birthday: vcardData.birthday || modalContact.birthday || '',
                photo: vcardData.photo || modalContact.photo || '',
              }
            : c,
        );
        selectedContact = contacts.find((c) => c.id === id) || selectedContact;
        draft = selectedContact ? { ...selectedContact } : null;
        toasts?.show?.('Contact updated', 'success');
      } else {
        const created = (await Remote.request('ContactsCreate', payload, {
          method: 'POST',
          pathOverride: '/v1/contacts',
        })) as Record<string, unknown>;
        const vcardData = parseVCard(created?.content as string);
        const mapped: Contact = {
          id: (created?.id || created?.contact_id || created?.uid || created?.Id) as string,
          name: (created?.full_name as string) || name,
          email:
            (created?.emails as { value: string }[])?.[0]?.value ||
            (created?.email as string) ||
            email,
          phone:
            (created?.phone_numbers as { value: string }[])?.[0]?.value ||
            (created?.phone as string) ||
            modalContact.phone ||
            '',
          notes: vcardData.notes || modalContact.notes || '',
          company: vcardData.company || modalContact.company || '',
          jobTitle: vcardData.jobTitle || modalContact.jobTitle || '',
          timezone: vcardData.timezone || modalContact.timezone || '',
          website: vcardData.website || modalContact.website || '',
          birthday: vcardData.birthday || modalContact.birthday || '',
          photo: vcardData.photo || modalContact.photo || '',
          raw: created,
        };
        contacts = [mapped, ...contacts];
        selectedContact = mapped;
        draft = { ...mapped };
        toasts?.show?.('Contact created', 'success');
      }
      applyFilter();
      // Surgically update the specific contact in cache
      if (selectedContact) {
        upsertContactInCache({
          id: selectedContact.id,
          email: selectedContact.email,
          name: selectedContact.name,
          avatar: selectedContact.photo || '',
          company: selectedContact.company || '',
        }).catch(() => {});
      }
      modalVisible = false;
    } catch (err) {
      modalError = (err as Error)?.message || 'Unable to save contact.';
    } finally {
      modalSaving = false;
    }
  };

  const openDeleteConfirm = (contact: Contact | null) => {
    confirmTarget = contact;
    confirmVisible = true;
  };

  const cancelDelete = () => {
    confirmVisible = false;
    confirmTarget = null;
  };

  const deleteContact = async () => {
    if (!confirmTarget?.id) return;
    try {
      await Remote.request(
        'ContactsDelete',
        {},
        { method: 'DELETE', pathOverride: `/v1/contacts/${encodeURIComponent(confirmTarget.id)}` },
      );
      contacts = contacts.filter((c) => c.id !== confirmTarget?.id);
      if (selectedContact?.id === confirmTarget.id) {
        selectedContact = null;
        draft = null;
      }
      applyFilter();
      // Surgically remove the deleted contact from cache
      removeContactFromCache(confirmTarget.id).catch(() => {});
      toasts?.show?.('Contact deleted', 'success');
    } catch (err) {
      error = (err as Error)?.message || 'Unable to delete contact.';
      toasts?.show?.(error, 'error');
    }
    cancelDelete();
  };

  onMount(() => {
    const mediaQuery = window.matchMedia ? window.matchMedia('(max-width: 720px)') : null;
    const handleViewportChange = (event: MediaQueryListEvent | MediaQueryList | null) => {
      const isMobile = event?.matches ?? isMobileViewport();
      if (isMobile && selectedContact) {
        selectContact(null);
      } else if (!isMobile && !selectedContact && contacts.length) {
        selectContact(contacts[0]);
      }
    };

    accountUnsub = currentAccount.subscribe((acct) => {
      if (acct !== lastAccount) {
        lastAccount = acct || '';
        resetContactsState();
        if (lastAccount) {
          load();
        }
      }
    });

    load();
    handleViewportChange(mediaQuery);
    if (mediaQuery) {
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', handleViewportChange);
      }
    }
    registerApi?.({
      reload: load,
    });

    return () => {
      accountUnsub?.();
      if (mediaQuery) {
        if (mediaQuery.removeEventListener) {
          mediaQuery.removeEventListener('change', handleViewportChange);
        }
      }
    };
  });

  onDestroy(() => {
    accountUnsub?.();
  });
</script>

<div class="flex h-14 items-center justify-between border-b border-border bg-background px-4">
  <div class="flex items-center gap-3">
    <Button variant="ghost" size="icon" onclick={() => navigate?.('/mailbox')} aria-label="Back">
      <ChevronLeft class="h-5 w-5" />
    </Button>
    <div class="flex flex-col">
      <h1 class="text-lg font-semibold">Contacts</h1>
      <span class="text-xs text-muted-foreground">{activeEmail}</span>
    </div>
  </div>
  <div class="flex items-center gap-2">
    <DropdownMenu.Root bind:open={importMenuOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="ghost" size="icon" {...props} aria-label="Import vCard">
            <Upload class="h-4 w-4" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item class="cursor-pointer p-0">
          <label class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5">
            <input type="file" accept=".vcf,text/vcard" onchange={importVCard} class="hidden" />
            <span>Import vCard</span>
          </label>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <Button onclick={startNew}>
      <Plus class="mr-2 h-4 w-4" />
      New Contact
    </Button>
  </div>
</div>

{#if error}
  <Alert.Root variant="destructive" class="mx-4 mt-4">
    <AlertCircle class="h-4 w-4" />
    <Alert.Description>{error}</Alert.Description>
  </Alert.Root>
{/if}

<div class="grid h-[calc(100vh-3.5rem)] grid-cols-1 md:grid-cols-[320px_1fr]">
  <!-- Contact List -->
  <div class="flex flex-col border-r border-border {selectedContact ? 'hidden md:flex' : 'flex'}">
    <div class="p-3">
      <div class="relative">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search contacts"
          bind:value={query}
          oninput={applyFilter}
          class="pl-9"
        />
      </div>
    </div>
    <ul class="flex-1 overflow-y-auto">
      {#if loading}
        <li class="p-4 text-center text-sm text-muted-foreground">Loading contacts...</li>
      {:else if filtered.length === 0}
        <li class="p-4 text-center text-sm text-muted-foreground">No contacts found.</li>
      {:else}
        {#each filtered as contact (contact.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-3 border-l-[3px] px-3 py-2.5 text-left transition-colors hover:bg-accent/50 {selectedContact?.id ===
              contact.id
                ? 'border-l-primary bg-primary/10'
                : 'border-l-transparent'}"
              onclick={() => selectContact(contact)}
            >
              <Avatar.Root
                class="h-8 w-8 shrink-0"
                style="background-color: {getAvatarColor(contact)}"
              >
                {#if contact.photo}
                  <Avatar.Image src={contact.photo} alt={contact.name || 'Contact'} />
                {:else}
                  <Avatar.Fallback
                    class="text-white text-xs font-semibold"
                    style="background-color: {getAvatarColor(contact)}"
                  >
                    {getInitials(contact)}
                  </Avatar.Fallback>
                {/if}
              </Avatar.Root>
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{contact.name || contact.email || 'Contact'}</div>
                <div class="truncate text-xs text-muted-foreground">{contact.email}</div>
              </div>
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  </div>

  <!-- Contact Detail -->
  <div class="overflow-y-auto p-4 md:p-6 {selectedContact ? 'block' : 'hidden md:block'}">
    {#if selectedContact && draft}
      <div class="mx-auto max-w-2xl">
        <!-- Header with avatar and actions -->
        <div class="mb-6 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            class="md:hidden"
            onclick={() => selectContact(null)}
            aria-label="Back to contacts"
          >
            <ChevronLeft class="h-5 w-5" />
          </Button>
          <label
            for="contact-photo-upload"
            class="group relative h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-full"
            style="background-color: {getAvatarColor(draft)}"
          >
            {#if draft.photo}
              <img
                src={draft.photo}
                alt={draft.name || 'Contact'}
                class="h-full w-full object-cover"
              />
            {:else}
              <span
                class="flex h-full w-full items-center justify-center text-xl font-bold text-white"
              >
                {getInitials(draft)}
              </span>
            {/if}
            <span
              class="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <Camera class="h-6 w-6" />
            </span>
          </label>
          <div class="min-w-0 flex-1">
            <div class="text-lg font-semibold">
              {draft.name || selectedContact.name || selectedContact.email}
            </div>
            <div class="text-sm text-muted-foreground">{selectedContact.email}</div>
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button variant="outline" size="icon" {...props}>
                  <MoreHorizontal class="h-4 w-4" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="w-48">
              <DropdownMenu.Item onclick={() => startMail(selectedContact)}>
                <Mail class="mr-2 h-4 w-4" />
                Email
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => addEvent(selectedContact)}>
                <CalendarPlus class="mr-2 h-4 w-4" />
                Add event
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => viewEmails(selectedContact)}>
                <Search class="mr-2 h-4 w-4" />
                View emails
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => exportVCard(selectedContact)}>
                <Download class="mr-2 h-4 w-4" />
                Export vCard
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                class="text-destructive"
                onclick={() => openDeleteConfirm(selectedContact)}
              >
                <Trash2 class="mr-2 h-4 w-4" />
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>

        <!-- Contact Form -->
        <Card.Root>
          <Card.Content class="space-y-4 pt-6">
            <div class="space-y-2">
              <Label for="contact-name">Name</Label>
              <Input id="contact-name" type="text" bind:value={draft.name} />
            </div>
            <div class="space-y-2">
              <Label for="contact-email">Email</Label>
              <Input id="contact-email" type="email" bind:value={draft.email} />
            </div>
            <div class="space-y-2">
              <Label for="contact-phone">Phone</Label>
              <Input id="contact-phone" type="tel" bind:value={draft.phone} />
            </div>
            <div class="space-y-2">
              <Label for="contact-notes">Notes</Label>
              <Textarea id="contact-notes" rows={4} bind:value={draft.notes} />
            </div>

            {#if draft.photo}
              <Button variant="ghost" size="sm" onclick={removePhoto}>Remove photo</Button>
            {/if}

            <input
              id="contact-photo-upload"
              type="file"
              accept="image/*"
              onchange={handlePhotoSelect}
              class="hidden"
            />

            <!-- Optional Fields -->
            <div class="border-t border-border pt-4">
              <button
                type="button"
                class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                onclick={() => (optionalFieldsExpanded = !optionalFieldsExpanded)}
              >
                {#if optionalFieldsExpanded}
                  <ChevronDown class="h-4 w-4" />
                {:else}
                  <ChevronRight class="h-4 w-4" />
                {/if}
                <span>Additional info</span>
                {#if !optionalFieldsExpanded && (draft.company || draft.jobTitle || draft.timezone || draft.website || draft.birthday)}
                  <span class="text-primary">*</span>
                {/if}
              </button>

              {#if optionalFieldsExpanded}
                <div class="mt-4 space-y-4">
                  <div class="space-y-2">
                    <Label for="contact-company">Company</Label>
                    <Input id="contact-company" type="text" bind:value={draft.company} />
                  </div>
                  <div class="space-y-2">
                    <Label for="contact-job">Job Title</Label>
                    <Input id="contact-job" type="text" bind:value={draft.jobTitle} />
                  </div>
                  <div class="space-y-2">
                    <Label for="contact-timezone">Time Zone</Label>
                    <Input
                      id="contact-timezone"
                      type="text"
                      placeholder="e.g., America/Chicago"
                      bind:value={draft.timezone}
                    />
                  </div>
                  <div class="space-y-2">
                    <Label for="contact-website">Website</Label>
                    <Input
                      id="contact-website"
                      type="url"
                      placeholder="https://"
                      bind:value={draft.website}
                    />
                  </div>
                  <div class="space-y-2">
                    <Label for="contact-birthday">Birthday</Label>
                    <Input id="contact-birthday" type="date" bind:value={draft.birthday} />
                  </div>
                </div>
              {/if}
            </div>
          </Card.Content>
          {#if hasChanges}
            <Card.Footer class="flex justify-end gap-2">
              <Button variant="ghost" onclick={cancelEditInline}>Cancel</Button>
              <Button onclick={saveInline}>Save</Button>
            </Card.Footer>
          {/if}
        </Card.Root>

        <!-- Privacy Message -->
        <div class="mt-6 flex items-center gap-2 bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info class="h-4 w-4 shrink-0" />
          <span>Privacy: Contacts are stored privately in your account and are never shared.</span>
        </div>
      </div>
    {:else}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        <div class="text-center">
          <User class="mx-auto h-12 w-12 opacity-50" />
          <p class="mt-2">Select a contact to view details.</p>
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Create/Edit Contact Modal -->
<Dialog.Root bind:open={modalVisible}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{modalMode === 'edit' ? 'Edit contact' : 'New contact'}</Dialog.Title>
    </Dialog.Header>
    <div class="space-y-4 py-4">
      <div class="space-y-2">
        <Label for="modal-name">Name</Label>
        <Input id="modal-name" type="text" bind:value={modalContact.name} />
      </div>
      <div class="space-y-2">
        <Label for="modal-email">Email</Label>
        <Input id="modal-email" type="email" bind:value={modalContact.email} required />
      </div>
      <div class="space-y-2">
        <Label for="modal-phone">Phone</Label>
        <Input id="modal-phone" type="tel" bind:value={modalContact.phone} />
      </div>
      <div class="space-y-2">
        <Label for="modal-notes">Notes</Label>
        <Textarea id="modal-notes" rows={4} bind:value={modalContact.notes} />
      </div>
      {#if modalError}
        <Alert.Root variant="destructive">
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>{modalError}</Alert.Description>
        </Alert.Root>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (modalVisible = false)}>Cancel</Button>
      <Button onclick={saveModal} disabled={modalSaving}>
        {modalSaving ? 'Saving...' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Delete Confirmation Dialog -->
<Dialog.Root bind:open={confirmVisible}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete contact?</Dialog.Title>
      <Dialog.Description>
        This will permanently delete <strong
          >{confirmTarget?.name || confirmTarget?.email || 'this contact'}</strong
        >. This can't be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" onclick={cancelDelete}>Cancel</Button>
      <Button variant="destructive" onclick={deleteContact}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
