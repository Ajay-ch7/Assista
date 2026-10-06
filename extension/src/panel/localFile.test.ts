import { describe, expect, it } from 'vitest';
import { readLocalPdf } from './localFile';

/** Stands in for XMLHttpRequest: answers each send with the given outcome. */
function fakeRequest(outcome: { status?: number; body?: string; fail?: 'error' | 'timeout' }) {
  const opened: string[] = [];
  const request = {
    status: outcome.status ?? 0,
    response: null as ArrayBuffer | null,
    responseType: '',
    timeout: 0,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    ontimeout: null as (() => void) | null,
    open: (_method: string, url: string) => opened.push(url),
    send() {
      if (outcome.fail === 'error') return this.onerror?.();
      if (outcome.fail === 'timeout') return this.ontimeout?.();
      this.response = outcome.body
        ? (new TextEncoder().encode(outcome.body).buffer as ArrayBuffer)
        : null;
      this.onload?.();
    },
  };
  return { make: () => request as unknown as XMLHttpRequest, opened, request };
}

const FILE = 'file:///C:/Users/me/Resume.pdf';

describe('readLocalPdf', () => {
  it('reads a PDF on the computer as base64', async () => {
    const { make, opened, request } = fakeRequest({ body: '%PDF-1.7 resume' });
    expect(await readLocalPdf(FILE, make)).toEqual({
      ok: true,
      url: FILE,
      data: btoa('%PDF-1.7 resume'),
      mime: 'application/pdf',
    });
    expect(opened).toEqual([FILE]);
    expect(request.responseType).toBe('arraybuffer');
  });

  it('refuses a file that is not a PDF', async () => {
    const { make } = fakeRequest({ body: 'plain text' });
    expect(await readLocalPdf(FILE, make)).toEqual({ ok: false, error: 'not_pdf' });
  });

  it('reports a file that cannot be read, or takes too long', async () => {
    expect(await readLocalPdf(FILE, fakeRequest({ fail: 'error' }).make)).toEqual({
      ok: false,
      error: 'fetch_failed: file',
    });
    expect(await readLocalPdf(FILE, fakeRequest({ fail: 'timeout' }).make)).toEqual({
      ok: false,
      error: 'timeout',
    });
  });

  it('opens nothing but files on the computer', async () => {
    const { make, opened } = fakeRequest({ body: '%PDF-1.7' });
    expect(await readLocalPdf('https://evil.example/x.pdf', make)).toEqual({
      ok: false,
      error: 'not_pdf',
    });
    expect(opened).toEqual([]);
  });
});
