"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/button"
import { toast } from "@/components/toast"
import { useInputHistory } from "@/hooks/use-input-history"
import { useEditorImageCapability } from "@/lib/swr"

type AgentState = {
  sessionId: string | null
  status: string
  isActive: boolean
  isWaiting: boolean
  canSend: boolean
  sendMessage: (msg: string, images?: string[]) => Promise<boolean>
  startSession: (msg: string, jigId?: string, images?: string[]) => Promise<boolean>
  reset: () => Promise<void>
}

// Downscale pasted images client-side so the authoring model gets a sane payload.
const MAX_IMAGE_EDGE = 1568
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Failed to load image"))
    }
    img.src = url
  })
}

/** Draw the image onto an offscreen canvas capped at MAX_IMAGE_EDGE on its longest
 *  edge, re-encoding to a PNG (for PNG sources) or JPEG data: URL. */
async function downscaleImageToDataUrl(file: File): Promise<string> {
  const img = await loadImageElement(file)
  const longest = Math.max(img.width, img.height) || 1
  const scale = Math.min(1, MAX_IMAGE_EDGE / longest)
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas not supported")
  ctx.drawImage(img, 0, 0, w, h)
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg"
  return canvas.toDataURL(mime, 0.9)
}

/** Approximate decoded byte size of a data: URL from its base64 payload. */
function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor((b64.length * 3) / 4)
}

export function AgentInput({
  agent,
  jigId,
  idlePlaceholder = "Describe a change...",
  variant = "default",
  externalValue,
  onExternalValueChange,
  autoFocus = false,
}: {
  agent: AgentState
  jigId?: string
  idlePlaceholder?: string
  variant?: "default" | "create"
  externalValue?: string
  onExternalValueChange?: (value: string) => void
  autoFocus?: boolean
}) {
  const prevStatusRef = useRef(agent.status)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const input = useInputHistory({ externalValue, onExternalValueChange })
  const [pastedImages, setPastedImages] = useState<string[]>([])
  const { editorModelId, supportsImages: editorSupportsImages } = useEditorImageCapability()

  // Clear input when agent starts waiting for user response
  useEffect(() => {
    if (agent.status === "waiting" && prevStatusRef.current !== "waiting") {
      input.clear()
    }
    prevStatusRef.current = agent.status
  }, [agent.status, input])

  useEffect(() => {
    if (!autoFocus) return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [autoFocus])

  // Grow the textarea with its content, up to the CSS max-height cap.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [input.value])

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (imageFiles.length === 0) return
    // Keep the pasted image out of the text field (some browsers insert a filename).
    e.preventDefault()
    for (const file of imageFiles) {
      try {
        const dataUrl = await downscaleImageToDataUrl(file)
        if (dataUrlByteLength(dataUrl) > MAX_IMAGE_BYTES) {
          toast.error("Image is too large to send even after downscaling — skipped.")
          continue
        }
        setPastedImages((prev) => [...prev, dataUrl])
      } catch {
        toast.error("Couldn't read that pasted image.")
      }
    }
  }

  function removeImage(index: number) {
    setPastedImages((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSend() {
    const trimmed = input.value.trim()
    const hasImages = pastedImages.length > 0
    if ((!trimmed && !hasImages) || !agent.canSend) return

    // Locked gate: only send images when the editor model is known to accept them.
    if (hasImages && editorSupportsImages !== true) {
      toast.error(
        `The editor model ${editorModelId ?? "(unknown)"} can't read images — pick a vision-capable model in Settings → Models.`,
      )
      return
    }

    const images = hasImages ? pastedImages : undefined
    const text = trimmed || "Here's an image — take a look."

    let ok = false
    if (agent.sessionId) {
      ok = await agent.sendMessage(text, images)
    } else {
      ok = await agent.startSession(text, jigId, images)
    }
    if (ok) {
      if (trimmed) input.commit(trimmed)
      else input.clear()
      setPastedImages([])
    }
  }

  const placeholder = agent.isWaiting
    ? "Type your answer..."
    : agent.sessionId
      ? "Follow up..."
      : idlePlaceholder

  const canSubmit = (!!input.value.trim() || pastedImages.length > 0) && agent.canSend

  return (
    <div className="flex flex-col gap-2">
      {pastedImages.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pastedImages.map((src, i) => (
            <div
              key={i}
              className="relative h-12 w-12 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="pasted attachment" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                aria-label="Remove image"
                className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/70 text-[11px] leading-none text-white transition-colors hover:bg-black/90"
              >
                &#10005;
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 transition-colors duration-150 focus-within:border-emerald-500/40 focus-within:ring-1 focus-within:ring-emerald-500/20">
        <textarea
          ref={inputRef}
          rows={1}
          value={input.value}
          onChange={(e) => input.setValue(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter falls through to insert a newline.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void handleSend()
              return
            }
            const el = e.currentTarget
            // Only browse history when the caret can't move further up/down.
            if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n")) {
              e.preventDefault()
              input.browsePrevious()
              return
            }
            if (e.key === "ArrowDown" && !el.value.slice(el.selectionEnd).includes("\n")) {
              e.preventDefault()
              input.browseNext()
            }
          }}
          placeholder={placeholder}
          disabled={!agent.canSend}
          autoFocus={autoFocus}
          className="flex-1 resize-none max-h-32 overflow-y-auto bg-transparent text-[12px] leading-[18px] text-[var(--text-primary)] outline-none border-0 ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 placeholder:text-[var(--text-dim)] disabled:opacity-50"
        />
        {(agent.status === "done" || agent.status === "error") && (
          <Button
            onClick={() => {
              input.clear()
              input.clearHistory()
              setPastedImages([])
              void agent.reset()
            }}
            variant="subtle"
            size="xs"
          >
            Clear
          </Button>
        )}
        <Button
          onClick={() => void handleSend()}
          disabled={!canSubmit}
          variant="success"
          size="xs"
        >
          {!agent.sessionId && variant === "create" ? "Create" : "↑"}
        </Button>
      </div>
    </div>
  )
}
