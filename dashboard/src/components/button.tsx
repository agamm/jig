"use client"

import type { ButtonHTMLAttributes, ReactNode } from "react"

function buttonClasses({
  variant,
  size,
  disabled,
}: {
  variant: "subtle" | "danger" | "success" | "successOutline" | "accent"
  size: "xs" | "sm" | "md"
  disabled?: boolean
}) {
  const base =
    "inline-flex items-center justify-center rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
  const variants = {
    subtle: "border border-[#1f1f23] bg-[#111113] text-[#555] hover:bg-[#1a1a1d] hover:text-[#888]",
    danger: "border border-rose-500/20 bg-rose-500/[0.06] text-rose-300 hover:border-rose-500/30 hover:bg-rose-500/[0.1] hover:text-rose-200",
    success: "bg-emerald-600 text-white hover:bg-emerald-500",
    successOutline: "border border-emerald-600/30 bg-emerald-600/10 text-emerald-400 hover:bg-emerald-600/20",
    accent: "bg-blue-600 text-white hover:bg-blue-500",
  }
  const sizes = {
    xs: "px-2 py-0.5 text-[10px]",
    sm: "px-2 py-1 text-[11px]",
    md: "px-3 py-1.5 text-[11px]",
  }

  return `${base} ${variants[variant]} ${sizes[size]}${disabled ? "" : ""}`
}

export function Button({
  variant = "subtle",
  size = "sm",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "subtle" | "danger" | "success" | "successOutline" | "accent"
  size?: "xs" | "sm" | "md"
  children: ReactNode
}) {
  return (
    <button
      {...props}
      className={`${buttonClasses({ variant, size, disabled: props.disabled })} ${className}`.trim()}
    >
      {children}
    </button>
  )
}
