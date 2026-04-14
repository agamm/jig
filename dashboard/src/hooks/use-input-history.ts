"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export function useInputHistory(options: {
  externalValue?: string
  onExternalValueChange?: (value: string) => void
} = {}) {
  const { externalValue, onExternalValueChange } = options
  const [value, setValueState] = useState(externalValue ?? "")
  const valueRef = useRef(value)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const draftRef = useRef("")

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    if (externalValue === undefined) return
    valueRef.current = externalValue
    setValueState(externalValue)
    historyIndexRef.current = -1
    draftRef.current = ""
  }, [externalValue])

  const setValue = useCallback((next: string) => {
    valueRef.current = next
    setValueState(next)
    onExternalValueChange?.(next)
    historyIndexRef.current = -1
  }, [onExternalValueChange])

  const commit = useCallback((submitted: string) => {
    const trimmed = submitted.trim()
    if (!trimmed) return
    if (historyRef.current[historyRef.current.length - 1] !== trimmed) {
      historyRef.current = [...historyRef.current, trimmed]
    }
    historyIndexRef.current = -1
    draftRef.current = ""
    valueRef.current = ""
    setValueState("")
    onExternalValueChange?.("")
  }, [onExternalValueChange])

  const clear = useCallback(() => {
    historyIndexRef.current = -1
    draftRef.current = ""
    valueRef.current = ""
    setValueState("")
    onExternalValueChange?.("")
  }, [onExternalValueChange])

  const clearHistory = useCallback(() => {
    historyRef.current = []
    historyIndexRef.current = -1
    draftRef.current = ""
  }, [])

  const browsePrevious = useCallback((): boolean => {
    if (historyRef.current.length === 0) return false
    if (historyIndexRef.current === -1) {
      draftRef.current = valueRef.current
      historyIndexRef.current = historyRef.current.length - 1
    } else if (historyIndexRef.current > 0) {
      historyIndexRef.current -= 1
    }

    const next = historyRef.current[historyIndexRef.current]
    if (next === undefined) return false
    valueRef.current = next
    setValueState(next)
    onExternalValueChange?.(next)
    return true
  }, [onExternalValueChange])

  const browseNext = useCallback((): boolean => {
    if (historyIndexRef.current === -1) return false

    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current += 1
      const next = historyRef.current[historyIndexRef.current]
      valueRef.current = next
      setValueState(next)
      onExternalValueChange?.(next)
      return true
    }

    historyIndexRef.current = -1
    valueRef.current = draftRef.current
    setValueState(draftRef.current)
    onExternalValueChange?.(draftRef.current)
    return true
  }, [onExternalValueChange])

  return {
    value,
    setValue,
    commit,
    clear,
    clearHistory,
    browsePrevious,
    browseNext,
  }
}
