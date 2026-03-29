/**
 * Laser-border spinner — conic gradient with glow, matches running-step style.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  const borderWidth = Math.max(0.5, size * 0.05)
  return (
    <span
      className={`relative inline-block shrink-0 rounded-full overflow-hidden ${className}`}
      style={{ width: size, height: size, filter: `drop-shadow(0 0 ${size * 0.3}px rgba(110,190,255,0.7))` }}
    >
      <span
        className="absolute inset-[-200%]"
        style={{
          animation: "spin-light 1.2s linear infinite",
          background: "conic-gradient(transparent 160deg, rgba(110,190,255,0.7) 200deg, rgba(169,216,255,1) 260deg, rgba(230,242,255,1) 280deg, rgba(169,216,255,1) 300deg, rgba(110,190,255,0.7) 340deg, transparent 360deg)",
        }}
      />
      <span
        className="absolute rounded-full bg-[#161619]"
        style={{ inset: borderWidth }}
      />
    </span>
  )
}
