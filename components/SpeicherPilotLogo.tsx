type SpeicherPilotLogoProps = {
  className?: string;
  size?: number;
};

/**
 * Minimal vector mark: stylized “Δ” (delta / change) with an energy pulse arc — distinctive at favicon scale.
 */
export function SpeicherPilotLogo({ className, size = 32 }: SpeicherPilotLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id="speicherpilot-logo-a" x1="6" y1="34" x2="34" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34d399" />
          <stop offset="0.45" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
        <linearGradient id="speicherpilot-logo-b" x1="10" y1="30" x2="30" y2="10" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fbbf24" stopOpacity="0.95" />
          <stop offset="1" stopColor="#f59e0b" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="12" className="fill-slate-950/90 dark:fill-slate-900/95" />
      <rect
        x="1"
        y="1"
        width="38"
        height="38"
        rx="12"
        stroke="url(#speicherpilot-logo-a)"
        strokeWidth="1.25"
        className="opacity-90"
      />
      <path
        d="M20 9 L30 28 H10 Z"
        fill="url(#speicherpilot-logo-a)"
        className="opacity-95"
      />
      <path
        d="M20 14 Q26 20 20 26 Q14 20 20 14"
        stroke="url(#speicherpilot-logo-b)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        className="opacity-90"
      />
    </svg>
  );
}
