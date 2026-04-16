/**
 * Template and Signature types.
 *
 * Shape is intentionally server-ready: field names mirror what the
 * forwardemail.net API is likely to adopt when cross-client sync ships.
 * v1 stores these client-side only, keyed per account in the `meta` KV table.
 */

export interface Template {
  id: string;
  name: string;
  body: string;
  useInReplies: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Signature {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateInput {
  name: string;
  body: string;
  useInReplies?: boolean;
}

export interface SignatureInput {
  name: string;
  body: string;
  isDefault?: boolean;
}

export const SIGNATURE_MARKER_ATTR = 'data-signature-id';
