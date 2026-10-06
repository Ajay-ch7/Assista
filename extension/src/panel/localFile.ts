// Reads a PDF stored on the user's computer. fetch() cannot open file:// addresses, but
// XMLHttpRequest can, from an extension page, once "Allow access to file URLs" is on.
// The service worker has no XMLHttpRequest, so the panel does this part.

import { pdfReply } from '../background/documents';
import type { DocumentReply } from '../shared/messages';

const TIMEOUT_MS = 20_000;

export function readLocalPdf(
  url: string,
  makeRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<DocumentReply> {
  return new Promise((resolve) => {
    if (!url.startsWith('file:')) {
      resolve({ ok: false, error: 'not_pdf' });
      return;
    }
    const request = makeRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.timeout = TIMEOUT_MS;
    request.onload = () => {
      // A file read reports status 0 on success.
      if ((request.status === 0 || request.status === 200) && request.response) {
        resolve(pdfReply(url, new Uint8Array(request.response as ArrayBuffer)));
      } else {
        resolve({ ok: false, error: `fetch_failed: ${request.status}` });
      }
    };
    request.onerror = () => resolve({ ok: false, error: 'fetch_failed: file' });
    request.ontimeout = () => resolve({ ok: false, error: 'timeout' });
    request.send();
  });
}
