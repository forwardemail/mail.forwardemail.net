interface FolderLike {
  path?: string | null;
  name?: string | null;
  specialUse?: string | null;
}

const nameKey = (folder: FolderLike) => ({
  path: (folder?.path || '').toUpperCase(),
  name: (folder?.name || '').toUpperCase(),
});

const isNamed = (folder: FolderLike, wanted: string) => {
  const { path, name } = nameKey(folder);
  return path === wanted || name === wanted;
};

/**
 * Pick the folder that spam goes to, without looking at the user's setting.
 *
 * Forward Email creates both "Spam" and "Junk" on new accounts and flags both
 * as \Junk. IMAP clients tend to show one of them as their junk folder and
 * users report that one is "Spam", so when there are several candidates we
 * prefer Spam over Junk. Otherwise Report Spam files mail into a folder the
 * user's other mail app does not show.
 *
 * Returns the folder path, or null when there is no junk folder.
 */
export const detectJunkFolder = (folderList: FolderLike[] | null | undefined): string | null => {
  const list = Array.isArray(folderList) ? folderList.filter(Boolean) : [];
  if (!list.length) return null;

  let candidates = list.filter((f) => f.specialUse === '\\Junk');
  if (!candidates.length) {
    candidates = list.filter((f) => isNamed(f, 'SPAM') || isNamed(f, 'JUNK'));
  }
  if (!candidates.length) return null;

  const spam = candidates.find((f) => isNamed(f, 'SPAM'));
  return (spam || candidates[0]).path || null;
};
