import type { CSSProperties } from 'react';

const paths = {
  compress: 'M4 3h16M4 21h16M12 4v5m-3-3 3 3 3-3M12 20v-5m-3 3 3-3 3 3M5 12h14',
  archive: 'M3 3h18v5H3ZM5 8v13h14V8M10 12h4',
  unarchive: 'M3 3h18v5H3ZM5 8v13h14V8M12 17v-6m-3 3 3-3 3 3',
  plus: 'M12 5v14M5 12h14',
  fork: 'M6 3v12a4 4 0 0 0 4 4h8M6 7h8a4 4 0 0 0 4-4M15 16l3 3-3 3M15 4l3-3 3 3',
  send: 'm5 12 14-7-7 14-1-7-6-0Z M11 13l8-8',
  stop: 'M6 6h12v12H6z',
  chevron: 'm9 5 7 7-7 7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  folder: 'M3 7V5h6l2 2h10v13H3Z',
  chat: 'M4 4h16v12H9l-5 4Z',
  terminal: 'm4 6 6 6-6 6M13 18h7',
  down: 'm6 9 6 6 6-6',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6ZM8 12l3 3 5-6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  check: 'm5 12 4 4L19 6',
  alert: 'M12 3 2 21h20ZM12 9v5M12 17v1',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
} as const;

export function Icon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
