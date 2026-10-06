import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_BYTES,
  fetchDocument,
  isPdfUrl,
  pdfSnapshot,
  servesPdf,
  toBase64,
} from './documents';

const PDF = new TextEncoder().encode('%PDF-1.4\nhello');

function respond(body: Uint8Array, headers: Record<string, string> = {}, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const content = init?.method === 'HEAD' ? null : new Blob([body as BlobPart]);
    return new Response(content, { status, headers });
  };
  return { fetchFn, calls };
}

describe('isPdfUrl', () => {
  it.each([
    ['https://example.com/guide.pdf', true],
    ['http://127.0.0.1:8787/files/Report.PDF?v=2#page=3', true],
    ['https://example.com/guide.pdf.html', false],
    ['https://example.com/pdf', false],
    ['file:///C:/guide.pdf', false],
    ['not a url', false],
    [undefined, false],
  ])('%s is %s', (url, expected) => {
    expect(isPdfUrl(url)).toBe(expected);
  });
});

describe('servesPdf', () => {
  it('asks the server for the content type, with the user login', async () => {
    const { fetchFn, calls } = respond(PDF, { 'content-type': 'application/pdf' });
    expect(await servesPdf('https://example.com/download?id=4', fetchFn)).toBe(true);
    expect(calls[0].init).toMatchObject({ method: 'HEAD', credentials: 'include' });
  });

  it('says no for other pages, failures and non-web addresses', async () => {
    expect(
      await servesPdf('https://a.example/', respond(PDF, { 'content-type': 'text/html' }).fetchFn),
    ).toBe(false);
    const failing = async () => {
      throw new Error('offline');
    };
    expect(await servesPdf('https://a.example/', failing)).toBe(false);
    expect(await servesPdf('chrome://newtab/', respond(PDF).fetchFn)).toBe(false);
  });
});

describe('pdfSnapshot', () => {
  it('has no nodes and carries the pdf flag', () => {
    const snapshot = pdfSnapshot({ url: 'https://example.com/guide.pdf', title: 'guide.pdf' });
    expect(snapshot).toMatchObject({
      url: 'https://example.com/guide.pdf',
      title: 'guide.pdf',
      nodes: [],
      flags: { pdf: true, thin: false },
    });
    expect(snapshot.snapshot_id).toMatch(/^pdf[0-9a-f]{16}$/);
  });
});

describe('fetchDocument', () => {
  it('returns the file as base64 with the user login', async () => {
    const { fetchFn, calls } = respond(PDF);
    const reply = await fetchDocument('https://example.com/guide.pdf', fetchFn);
    expect(reply).toEqual({
      ok: true,
      url: 'https://example.com/guide.pdf',
      data: btoa('%PDF-1.4\nhello'),
      mime: 'application/pdf',
    });
    expect(calls[0].init).toMatchObject({ credentials: 'include' });
  });

  it('refuses a file that is not a PDF, too large, or not found', async () => {
    const html = new TextEncoder().encode('<html>sign in</html>');
    expect(await fetchDocument('https://a.example/x.pdf', respond(html).fetchFn)).toEqual({
      ok: false,
      error: 'not_pdf',
    });
    const big = respond(PDF, { 'content-length': String(MAX_DOCUMENT_BYTES + 1) });
    expect(await fetchDocument('https://a.example/x.pdf', big.fetchFn)).toEqual({
      ok: false,
      error: 'too_large',
    });
    expect(await fetchDocument('https://a.example/x.pdf', respond(PDF, {}, 404).fetchFn)).toEqual({
      ok: false,
      error: 'fetch_failed: 404',
    });
  });
});

describe('toBase64', () => {
  it('encodes large files in chunks', () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
