"use client"

import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react"

type ToastType = "success" | "error" | "info"
type ToastOptions = { durationMs?: number | null }
type Toast = { id: number; message: string; type: ToastType; durationMs: number | null }

let _addToast: (message: string, type: ToastType, options?: ToastOptions) => void = () => {}

export const toast = {
  success: (message: string, options?: ToastOptions) => _addToast(message, "success", options),
  error: (message: string, options?: ToastOptions) => _addToast(message, "error", options),
  info: (message: string, options?: ToastOptions) => _addToast(message, "info", options),
}

let nextId = 0

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [exiting, setExiting] = useState<Set<number>>(new Set())

  const dismiss = useCallback((id: number) => {
    setExiting(prev => new Set(prev).add(id))
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
      setExiting(prev => { const next = new Set(prev); next.delete(id); return next })
    }, 200)
  }, [])

  useEffect(() => {
    _addToast = (message, type, options) => {
      const id = nextId++
      const durationMs = options?.durationMs === undefined
        ? type === "info" ? 8000 : 4000
        : options.durationMs
      setToasts(prev => [...prev, { id, message, type, durationMs }])
      if (durationMs !== null) {
        setTimeout(() => dismiss(id), durationMs)
      }
    }
    return () => { _addToast = () => {} }
  }, [dismiss])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto flex max-w-sm cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-left text-[13px] font-medium shadow-lg backdrop-blur-sm transition-all duration-200 ${
            exiting.has(t.id) ? "translate-x-2 opacity-0" : "translate-x-0 opacity-100 animate-[slide-in_0.2s_ease-out]"
          } ${
            t.type === "success" ? "border-emerald-800/50 bg-emerald-950/80 text-emerald-300"
            : t.type === "error" ? "border-red-800/50 bg-red-950/80 text-red-300"
            : "border-amber-800/50 bg-amber-950/80 text-amber-300"
          }`}
        >
          <span className="whitespace-pre-line">{t.message}</span>
          <span className="ml-auto shrink-0 text-[14px] leading-none opacity-70">×</span>
        </button>
      ))}
    </div>
  )
}
