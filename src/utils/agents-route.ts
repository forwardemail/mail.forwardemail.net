/**
 * Agent mode is its own route tree under /agents (spec §5.1, §5.2), not a
 * filter on the mailbox.
 */

export type AgentsScreen =
  | { screen: 'queue'; section: 'waiting' | 'unusual' | 'done' }
  | { screen: 'action'; id: string }
  | { screen: 'agent'; id: string }
  | { screen: 'threads' }
  | { screen: 'thread'; id: string }
  | { screen: 'audit' }
  | { screen: 'policies' };

export function parseAgentsPath(pathname: string): AgentsScreen {
  const parts = pathname
    .replace(/^\/agents\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  const [head, id] = parts;

  switch (head) {
    case undefined:
      return { screen: 'queue', section: 'waiting' };
    case 'unusual':
      return { screen: 'queue', section: 'unusual' };
    case 'done':
      return { screen: 'queue', section: 'done' };
    case 'actions':
      return id ? { screen: 'action', id } : { screen: 'queue', section: 'waiting' };
    case 'threads':
      return id ? { screen: 'thread', id } : { screen: 'threads' };
    case 'audit':
      return { screen: 'audit' };
    case 'policies':
      return { screen: 'policies' };
    default:
      return { screen: 'agent', id: head };
  }
}
