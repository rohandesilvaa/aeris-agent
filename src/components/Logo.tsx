/** The Aeris Bot mark: an A whose crossbar is a single glowing core. */
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Aeris Bot">
      <defs>
        <linearGradient id="logo-mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#86dcff" />
        </linearGradient>
      </defs>
      <path d="M13 39 L24 9 L35 39" fill="none" stroke="url(#logo-mark)" strokeWidth="6.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="31.4" r="3.4" fill="#8edeff" />
    </svg>
  );
}
