"use client"

import type { ReactNode } from "react"

export function PaneSection({
  title,
  meta,
  children,
}: {
  title: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider">{title}</h3>
        {meta}
      </div>
      {children}
    </div>
  )
}
