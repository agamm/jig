/**
 * Orbiting dot spinner — glowing dot with comet trail.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  const stroke = Math.max(1.5, size * 0.1)
  const r = (size - stroke * 2) / 2
  const circ = 2 * Math.PI * r
  const cx = size / 2
  const cy = size / 2
  const dotR = Math.max(1, size * 0.08)

  return (
    <svg
      className={`shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <defs>
        <linearGradient id={`trail-${size}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(110,190,255,0)" />
          <stop offset="70%" stopColor="rgba(110,190,255,0.4)" />
          <stop offset="100%" stopColor="rgba(110,190,255,1)" />
        </linearGradient>
        <filter id={`glow-${size}`}>
          <feGaussianBlur stdDeviation={size * 0.08} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Faint track */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="rgba(110,190,255,0.06)"
        strokeWidth={stroke * 0.6}
      />

      {/* Comet trail */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke={`url(#trail-${size})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circ * 0.35} ${circ * 0.65}`}
        style={{ animation: "spin-light 1s linear infinite" }}
      />

      {/* Bright leading dot */}
      <circle
        cx={cx} cy={cy - r} r={dotR}
        fill="rgba(200,225,255,1)"
        filter={`url(#glow-${size})`}
        style={{ animation: "spin-light 1s linear infinite", transformOrigin: `${cx}px ${cy}px` }}
      />
    </svg>
  )
}
