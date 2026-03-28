"use client"

import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from "react"

type ToastType = "success" | "error" | "info"
type Toast = { id: number; message: string; type: ToastType }

let _addToast: (message: string, type: ToastType) => void = () => {}

export const toast = {
  success: (message: string) => _addToast(message, "success"),
  error: (message: string) => _addToast(message, "error"),
  info: (message: string) => _addToast(message, "info"),
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
    _addToast = (message, type) => {
      const id = nextId++
      setToasts(prev => [...prev, { id, message, type }])
      setTimeout(() => dismiss(id), 4000)
    }
    return () => { _addToast = () => {} }
  }, [dismiss])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto cursor-pointer rounded-lg border px-4 py-3 text-[13px] font-medium shadow-lg backdrop-blur-sm transition-all duration-200 ${
            exiting.has(t.id) ? "translate-x-2 opacity-0" : "translate-x-0 opacity-100 animate-[slide-in_0.2s_ease-out]"
          } ${
            t.type === "success" ? "border-emerald-800/50 bg-emerald-950/80 text-emerald-300"
            : t.type === "error" ? "border-red-800/50 bg-red-950/80 text-red-300"
            : "border-[#2a2a2e] bg-[#1a1a1e]/90 text-[#ccc]"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
