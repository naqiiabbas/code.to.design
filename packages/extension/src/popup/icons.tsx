const common = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const DesktopIcon = () => (
  <svg {...common} aria-hidden>
    <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
    <path d="M5.5 14h5M8 11v3" />
  </svg>
);

export const LaptopIcon = () => (
  <svg {...common} aria-hidden>
    <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
    <path d="M1 12.5h14" />
  </svg>
);

export const TabletIcon = () => (
  <svg {...common} aria-hidden>
    <rect x="3" y="1.5" width="10" height="13" rx="1.4" />
    <path d="M7 12.5h2" />
  </svg>
);

export const PhoneIcon = () => (
  <svg {...common} aria-hidden>
    <rect x="4.5" y="1.5" width="7" height="13" rx="1.6" />
    <path d="M7.2 12.6h1.6" />
  </svg>
);

export const SunIcon = () => (
  <svg {...common} aria-hidden>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1" />
  </svg>
);

export const MoonIcon = () => (
  <svg {...common} aria-hidden>
    <path d="M13.5 9.4A5.8 5.8 0 0 1 6.6 2.5a5.8 5.8 0 1 0 6.9 6.9Z" />
  </svg>
);
