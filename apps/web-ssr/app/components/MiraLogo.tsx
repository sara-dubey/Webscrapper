"use client";

import { useId } from "react";

type MiraLogoProps = {
  variant?: "nav" | "hero";
  className?: string;
  showWordmark?: boolean;
};

export default function MiraLogo({ variant = "nav", className = "", showWordmark = true }: MiraLogoProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipId = `mira-lens-clip-${uid}`;
  const wave1Id = `mira-wave1-${uid}`;
  const wave2Id = `mira-wave2-${uid}`;
  const wave3Id = `mira-wave3-${uid}`;
  const flameId = `mira-flame-${uid}`;
  const handleId = `mira-handle-${uid}`;

  return (
    <span className={`miraLogo ${variant === "hero" ? "miraLogoHero" : "miraLogoNav"} ${className}`.trim()} aria-label="MIRA logo">
      <span className="miraLogoIconWrap" aria-hidden="true">
        <svg className="miraSparkle" viewBox="0 0 48 46" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M34 2 L35.2 6.8 L40 8 L35.2 9.2 L34 14 L32.8 9.2 L28 8 L32.8 6.8 Z" fill="#7B3FC4" />
          <path d="M22 10 L23 13.4 L26.4 14.4 L23 15.4 L22 18.8 L21 15.4 L17.6 14.4 L21 13.4 Z" fill="#F5820D" />
          <path d="M32 18 L32.7 20.5 L35.2 21.2 L32.7 21.9 L32 24.4 L31.3 21.9 L28.8 21.2 L31.3 20.5 Z" fill="#E8A420" />
          <path d="M41 12 L41.5 13.8 L43.3 14.3 L41.5 14.8 L41 16.6 L40.5 14.8 L38.7 14.3 L40.5 13.8 Z" fill="#4DA6E8" />
          <circle cx="26" cy="6" r="2" fill="#9B4DCA" fillOpacity="0.7" />
        </svg>

        <svg className="miraMagSvg" viewBox="0 0 100 110" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <clipPath id={clipId}>
              <circle cx="44" cy="44" r="34" />
            </clipPath>
            <linearGradient id={wave1Id} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#6B3FA0" />
              <stop offset="100%" stopColor="#E05A9B" />
            </linearGradient>
            <linearGradient id={wave2Id} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3E8ED0" />
              <stop offset="50%" stopColor="#3DBFB8" />
              <stop offset="100%" stopColor="#52CC6A" />
            </linearGradient>
            <linearGradient id={wave3Id} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3DBFB8" />
              <stop offset="100%" stopColor="#52CC6A" />
            </linearGradient>
            <linearGradient id={flameId} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#E8420A" />
              <stop offset="50%" stopColor="#F5820D" />
              <stop offset="100%" stopColor="#FBCA2A" />
            </linearGradient>
            <linearGradient id={handleId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2A3F6E" />
              <stop offset="100%" stopColor="#1b2744" />
            </linearGradient>
          </defs>

          <circle cx="44" cy="44" r="34" fill="white" />
          <g clipPath={`url(#${clipId})`}>
            <path
              d="M10 36 Q22 24 34 30 Q46 36 58 28 Q70 20 82 26 L82 46 Q70 40 58 48 Q46 56 34 50 Q22 44 10 56 Z"
              fill={`url(#${wave1Id})`}
              opacity="0.9"
            />
            <path
              d="M10 46 Q22 38 34 44 Q46 50 58 42 Q70 34 82 40 L82 60 Q70 54 58 62 Q46 70 34 64 Q22 58 10 66 Z"
              fill={`url(#${wave2Id})`}
              opacity="0.9"
            />
            <path d="M10 58 Q22 50 34 56 Q46 62 58 54 Q70 46 82 52 L82 78 L10 78 Z" fill={`url(#${wave3Id})`} opacity="0.8" />
            <path d="M54 14 C54 14 68 22 66 36 C64 46 58 48 58 48 C58 48 72 40 70 26 C68 16 60 10 54 14 Z" fill={`url(#${flameId})`} />
            <path d="M60 20 C60 20 70 26 68 36 C66 44 62 46 62 46 C62 46 72 38 70 28 C68 18 64 16 60 20 Z" fill={`url(#${flameId})`} opacity="0.7" />
          </g>

          <circle cx="44" cy="44" r="34" fill="none" stroke="#1b2744" strokeWidth="5.5" />
          <line x1="70" y1="70" x2="88" y2="100" stroke={`url(#${handleId})`} strokeWidth="11" strokeLinecap="round" />
        </svg>
      </span>

      {showWordmark ? <span className="miraLogoWord">MIRA</span> : null}
    </span>
  );
}
