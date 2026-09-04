"use client"

import type { ButtonHTMLAttributes, ReactNode } from "react"

export function buttonClasses({
  variant,
  size,
}: {
  variant: "subtle" | "danger" | "success" | "successOutline" | "accent"
  size: "xs" | "sm" | "md" | "lg"
}) {
  const base =
    "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium outline-none transition-[background-color,border-color,color,transform,box-shadow] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
  const variants = {
    subtle: "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]",
    danger: "border border-rose-500/20 bg-rose-500/[0.07] text-rose-200 hover:border-rose-500/30 hover:bg-rose-500/[0.12]",
    success: "border border-emerald-500/40 bg-[var(--accent-primary-strong)] text-white shadow-[0_0_0_1px_rgba(16,185,129,0.08)] hover:bg-[var(--accent-primary)]",
    successOutline: "border border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-300 hover:bg-emerald-500/[0.14] hover:text-emerald-200",
    accent: "border border-blue-500/20 bg-blue-500/[0.08] text-blue-200 hover:bg-blue-500/[0.14]",
  }
  const sizes = {
    xs: "px-2 py-0.5 text-[10px]",
    sm: "px-2 py-1 text-[11px]",
    md: "px-3 py-1.5 text-[11px]",
    lg: "px-4 py-2 text-[12px]",
  }

  return `${base} ${variants[variant]} ${sizes[size]}`
}

export function Button({
  variant = "subtle",
  size = "sm",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "subtle" | "danger" | "success" | "successOutline" | "accent"
  size?: "xs" | "sm" | "md" | "lg"
  children: ReactNode
}) {
  return (
    <button
      {...props}
      className={`${buttonClasses({ variant, size })} ${className}`.trim()}
    >
      {children}
    </button>
  )
}
