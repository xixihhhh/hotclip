/**
 * HotClip brand mark — hand-drawn SVG, no emoji.
 * Concept: a squircle with its top-right corner CLIPPED off (= "clip"),
 * filled with the flame gradient (= "hot"), holding a white play triangle
 * whose top edge sweeps up like a flame lick (= video that catches fire).
 */
export function LogoMark({ size = 32 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="HotClip logo"
    >
      <defs>
        <linearGradient id="hc-flame" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff3d1f" />
          <stop offset="0.55" stopColor="#ff6a2e" />
          <stop offset="1" stopColor="#ffa03d" />
        </linearGradient>
        <linearGradient id="hc-shine" x1="24" y1="2" x2="24" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* squircle with clipped top-right corner (the "clip" cut) */}
      <path
        d="M15 2 H28.5 L46 19.5 V33 C46 40.18 40.18 46 33 46 H15 C7.82 46 2 40.18 2 33 V15 C2 7.82 7.82 2 15 2 Z"
        fill="url(#hc-flame)"
      />
      {/* cut facet: a lighter sliver along the clipped edge, like a fresh scissor cut */}
      <path d="M28.5 2 L46 19.5 L42.6 19.5 C35.4 19.5 28.5 12.9 28.5 5.6 Z" fill="#ffffff" opacity="0.22" />
      {/* top shine for depth */}
      <path
        d="M15 2 H28.5 L33 6.5 C28 10 14 12 4.5 8.9 C6.6 4.8 10.5 2 15 2 Z"
        fill="url(#hc-shine)"
      />
      {/* play triangle with a flame-lick top vertex */}
      <path
        d="M19.2 15.1
           C19.2 13.4 20.5 12.8 21.9 13.6
           L33.6 20.5
           C36.4 22.1 36.4 25.4 33.6 27.1
           L21.9 34.3
           C20.5 35.2 19.2 34.5 19.2 32.8
           V22.5
           C19.2 19.6 18.4 18.2 17.2 16.4
           C18 16.9 18.8 16.6 19.2 15.1 Z"
        fill="#ffffff"
      />
    </svg>
  );
}

/** Wordmark: brand name with a flame-gradient accent. */
export function LogoWordmark({ zh }: { zh?: boolean }): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1.5 select-none">
      <span className="text-[16px] font-extrabold tracking-tight">
        Hot<span className="flame-text">Clip</span>
      </span>
      {zh && <span className="text-[11px] font-semibold text-mut">爆款切片</span>}
    </span>
  );
}
