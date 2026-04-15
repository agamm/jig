"use client"

import type { ReactNode } from "react"

export function PaneHeader({
  title,
  statusDotClass,
  badge,
  actions,
}: {
  title: ReactNode
  statusDotClass?: string
  badge?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border)] px-4 gap-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)] whitespace-nowrap">{title}</h2>
        {statusDotClass && <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${statusDotClass}`} />}
        {badge}
      </div>
      {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
    </div>
  )
}
