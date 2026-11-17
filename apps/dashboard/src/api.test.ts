import { describe, expect, it } from 'vitest';
import { readApiJson } from './api.js';

describe('readApiJson', () => {
  it('parses JSON responses', async () => {
    const response = new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    });
    await expect(readApiJson<{ ok: boolean }>(response)).resolves.toEqual({ ok: true });
  });

  it('explains when a static HTML page is returned by the API', async () => {
    const response = new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expect(readApiJson(response)).rejects.toThrow(
      'Check that the dashboard API URL points to the Pigeon Worker',
    );
  });
});
