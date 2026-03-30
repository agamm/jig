/**
 * Three-dot pulse spinner — minimal, fits the dark theme.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  const dotSize = Math.max(2, size * 0.2)
  const gap = Math.max(2, size * 0.15)
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size, gap }}
    >
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="rounded-full"
          style={{
            width: dotSize,
            height: dotSize,
            background: "rgba(110,190,255,0.9)",
            boxShadow: `0 0 ${dotSize}px rgba(110,190,255,0.4)`,
            animation: `spinner-pulse 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </span>
  )
}
