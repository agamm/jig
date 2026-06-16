import type { ReactNode } from "react"

/**
 * Loading/pending label with the standard shine treatment: a bright blue
 * highlight sweeps across muted text with a soft glow matching <Spinner/>.
 * Use this (or the `.text-shimmer` class) for every "in progress" label so
 * loading states share one design language. Respects prefers-reduced-motion.
 */
export function ShimmerText({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`text-shimmer ${className}`.trim()}>{children}</span>
}
