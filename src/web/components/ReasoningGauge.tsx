const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** An ordinal indicator only; the select still exposes the exact server-provided value. */
export function ReasoningGauge({ effort }: { effort: string }) {
  const level = levels.indexOf(effort);
  const progress = level < 0 ? undefined : level / (levels.length - 1);
  const angle = Math.PI * (1 + (progress ?? 0));
  return (
    <svg
      className="reasoning-gauge"
      data-effort={effort}
      data-progress={progress}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 15a9 9 0 0 1 18 0"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {progress !== undefined ? (
        <>
          <path
            d="M3 15a9 9 0 0 1 18 0"
            pathLength="100"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${progress * 100} 100`}
          />
          <path
            d={`M12 15L${12 + Math.cos(angle) * 6} ${15 + Math.sin(angle) * 6}`}
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <circle cx="12" cy="15" r="2" fill="currentColor" />
        </>
      ) : (
        <text x="12" y="17" textAnchor="middle" fontSize="10" fill="currentColor">
          ?
        </text>
      )}
    </svg>
  );
}
