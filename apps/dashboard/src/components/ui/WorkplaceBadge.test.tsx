import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkplaceBadge, getWorkplaceType } from './WorkplaceBadge.js';

// @ts-expect-error React 19 testing flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkplaceBadge Component', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  it('correctly classifies remote jobs', () => {
    expect(getWorkplaceType({ remote: true, location: 'Worldwide' })).toBe('remote');
    expect(getWorkplaceType({ remote: false, location: 'Remote - India' })).toBe('remote');
    expect(getWorkplaceType({ remote: null, title: 'Remote Flutter Engineer' })).toBe('remote');
  });

  it('correctly classifies hybrid jobs', () => {
    expect(getWorkplaceType({ remote: false, location: 'Dubai, UAE (Hybrid)' })).toBe('hybrid');
    expect(getWorkplaceType({ remote: true, title: 'Hybrid Flutter Developer' })).toBe('hybrid');
  });

  it('correctly classifies on-site jobs', () => {
    expect(
      getWorkplaceType({
        remote: false,
        location: 'Bengaluru, India',
        title: 'Flutter Developer',
      }),
    ).toBe('onsite');
  });

  it('renders Remote badge', async () => {
    await act(async () => {
      root?.render(<WorkplaceBadge type="remote" />);
    });
    expect(container?.textContent).toContain('Remote');
  });

  it('renders Hybrid badge', async () => {
    await act(async () => {
      root?.render(<WorkplaceBadge type="hybrid" />);
    });
    expect(container?.textContent).toContain('Hybrid');
  });

  it('renders On-site badge', async () => {
    await act(async () => {
      root?.render(<WorkplaceBadge type="onsite" />);
    });
    expect(container?.textContent).toContain('On-site');
  });
});
