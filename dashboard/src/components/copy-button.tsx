"use client"

import { useState } from "react"
import { Button } from "@/components/button"
import { toast } from "@/components/toast"

/** Copies `text` to the clipboard and confirms with a toast; the label flips briefly to `copiedLabel`. */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  toast: toastMessage,
  size = "sm",
  variant = "subtle",
  className,
}: {
  text: string
  label?: string
  copiedLabel?: string
  toast: string
  size?: "xs" | "sm" | "md" | "lg"
  variant?: "subtle" | "danger" | "success" | "successOutline" | "accent"
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy(event: React.MouseEvent<HTMLButtonElement>) {
    // Rows that own the click (expandable steps, list items) must not toggle on copy.
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success(toastMessage)
    } catch {
      toast.error("Could not write to the clipboard. Select the text and copy it.")
    }
  }

  return (
    <Button type="button" onClick={copy} size={size} variant={variant} className={className}>
      {copied ? copiedLabel : label}
    </Button>
  )
}
