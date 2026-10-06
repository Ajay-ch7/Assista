// PDF documents. Chrome's PDF viewer shows no page a content script can read, so the
// worker fetches the file itself, with the user's own login, and the backend reads it.
// Only the address of the tab on show is ever fetched: the backend cannot name another.

import type { DocumentReply } from '../shared/messages';
import type { PageSnapshot } from '../shared/snapshot';

/** Larger files would not fit in one WebSocket message to the backend. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** True when the address itself names a PDF, such as /guide.pdf or /file.pdf?v=2. */
export function isPdfUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && /\.pdf$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Asks the server whether the address is a PDF, for addresses that do not say so. */
export async function servesPdf(url: string | undefined, fetchFn: Fetch = fetch): Promise<boolean> {
  if (!url || !/^https?:/.test(url)) return false;
  try {
    const response = await fetchFn(url, { method: 'HEAD', credentials: 'include' });
    return /application\/pdf/i.test(response.headers.get('content-type') ?? '');
  } catch {
    return false;
  }
}

/** The snapshot of a tab that shows a PDF: no nodes, and the pdf flag. */
export function pdfSnapshot(tab: { url?: string; title?: string }): PageSnapshot {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    url: tab.url ?? '',
    title: tab.title ?? '',
    snapshot_id: `pdf${id}`,
    nodes: [],
    tables: [],
    images: [],
    rules: { preticked: [], countdowns: [] },
    flags: {
      has_canvas: false,
      thin: false,
      clutter_removed: 0,
      hidden_text_removed: 0,
      pdf: true,
    },
  };
}

/** Fetches the PDF at `url` and returns it as base64 data. */
export async function fetchDocument(url: string, fetchFn: Fetch = fetch): Promise<DocumentReply> {
  let response: Response;
  try {
    response = await fetchFn(url, { credentials: 'include' });
  } catch (error) {
    return { ok: false, error: `fetch_failed: ${String(error)}` };
  }
  if (!response.ok) return { ok: false, error: `fetch_failed: ${response.status}` };
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) return { ok: false, error: 'too_large' };

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, error: 'too_large' };
  if (!startsWithPdfMarker(bytes)) return { ok: false, error: 'not_pdf' };
  return { ok: true, url, data: toBase64(bytes), mime: 'application/pdf' };
}

function startsWithPdfMarker(bytes: Uint8Array): boolean {
  // Some files carry a few bytes of junk before the %PDF marker.
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}
