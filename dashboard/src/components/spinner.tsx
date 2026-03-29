/**
 * Laser-border spinner — conic gradient with glow, matches running-step style.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  const borderWidth = Math.max(1.5, size * 0.22)
  return (
    <span
      className={`relative inline-block shrink-0 rounded-full overflow-hidden ${className}`}
      style={{ width: size, height: size, filter: `drop-shadow(0 0 ${size * 0.3}px rgba(96,165,250,0.6))` }}
    >
      <span
        className="absolute inset-[-200%]"
        style={{
          animation: "spin-light 1.2s linear infinite",
          background: "conic-gradient(transparent 160deg, rgba(96,165,250,0.6) 200deg, rgba(147,197,253,1) 260deg, rgba(200,220,255,1) 280deg, rgba(147,197,253,1) 300deg, rgba(96,165,250,0.6) 340deg, transparent 360deg)",
        }}
      />
      <span
        className="absolute rounded-full bg-[#161619]"
        style={{ inset: borderWidth }}
      />
    </span>
  )
}
