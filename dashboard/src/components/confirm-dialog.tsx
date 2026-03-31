"use client"

import { Button } from "@/components/button"

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  loading = false,
  destructive = false,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
  destructive?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-[#2a2a2e] bg-[#111113] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "fade-up 0.15s ease" }}
      >
        <div className="border-b border-[#1f1f23] px-5 py-4">
          <h3 className="text-[14px] font-semibold text-[#ededed]">{title}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[#666]">{message}</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <Button
            onClick={onClose}
            disabled={loading}
            variant="subtle"
            size="md"
            className="bg-[#0a0a0b] text-[#888] hover:border-[#2a2a2e] hover:text-[#ededed]"
          >
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={loading}
            variant={destructive ? "danger" : "success"}
            size="md"
            className={destructive ? "border-transparent text-white hover:bg-rose-500" : ""}
          >
            {loading ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
