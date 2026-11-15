import React from 'react';
import { Globe, Building, MapPin } from 'lucide-react';

export type WorkplaceType = 'remote' | 'hybrid' | 'onsite';

export function getWorkplaceType(item: {
  location?: string | null;
  remote?: boolean | number | null;
  title?: string | null;
}): WorkplaceType {
  const loc = (item.location || '').toLowerCase();
  const tit = (item.title || '').toLowerCase();
  if (loc.includes('hybrid') || tit.includes('hybrid')) {
    return 'hybrid';
  }
  if (
    item.remote === true ||
    item.remote === 1 ||
    loc.includes('remote') ||
    tit.includes('remote') ||
    loc.includes('worldwide') ||
    loc.includes('anywhere')
  ) {
    return 'remote';
  }
  return 'onsite';
}

interface WorkplaceBadgeProps {
  type: WorkplaceType;
  size?: 'xs' | 'sm';
}

export function WorkplaceBadge({ type, size = 'xs' }: WorkplaceBadgeProps): React.JSX.Element {
  if (type === 'remote') {
    return (
      <span
        className={`inline-flex items-center gap-1 font-medium rounded-[4px] bg-blue-500/10 text-blue-400 border border-blue-500/20 ${
          size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[12px]'
        }`}
      >
        <Globe size={11} strokeWidth={1.5} aria-hidden="true" />
        <span>Remote</span>
      </span>
    );
  }

  if (type === 'hybrid') {
    return (
      <span
        className={`inline-flex items-center gap-1 font-medium rounded-[4px] bg-purple-500/10 text-purple-400 border border-purple-500/20 ${
          size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[12px]'
        }`}
      >
        <Building size={11} strokeWidth={1.5} aria-hidden="true" />
        <span>Hybrid</span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 font-medium rounded-[4px] bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 ${
        size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[12px]'
      }`}
    >
      <MapPin size={11} strokeWidth={1.5} aria-hidden="true" />
      <span>On-site</span>
    </span>
  );
}
