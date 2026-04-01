"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { JigTool } from "@shared/api"

const STORAGE_KEY = "jig-tool-approvals-v1"

function normalizeTools(tools: JigTool[]): JigTool[] {
  return [...tools]
    .sort((a, b) =>
      `${a.connection}:${a.name}:${a.readOnly}`.localeCompare(`${b.connection}:${b.name}:${b.readOnly}`)
    )
}

export function getToolsetSignature(tools: JigTool[]): string {
  return normalizeTools(tools)
    .map((tool) => `${tool.connection}:${tool.name}:${tool.readOnly ? "ro" : "rw"}`)
    .join("|")
}

function getApprovalKey(jigId: string, signature: string): string {
  return `${jigId}::${signature}`
}

function readApprovalStore(): Record<string, true> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeApprovalStore(store: Record<string, true>) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

export function isToolsetApproved(jigId: string, tools: JigTool[]): boolean {
  if (tools.length === 0) return true
  const signature = getToolsetSignature(tools)
  if (!signature) return true
  const store = readApprovalStore()
  return store[getApprovalKey(jigId, signature)] === true
}

export function approveToolset(jigId: string, tools: JigTool[]) {
  if (tools.length === 0) return
  const signature = getToolsetSignature(tools)
  if (!signature) return
  const store = readApprovalStore()
  store[getApprovalKey(jigId, signature)] = true
  writeApprovalStore(store)
}

export function useJigToolApproval(jigId: string, tools: JigTool[]) {
  const signature = useMemo(() => getToolsetSignature(tools), [tools])
  const stableTools = useMemo(() => normalizeTools(tools), [signature])
  const [approved, setApproved] = useState<boolean>(() => isToolsetApproved(jigId, stableTools))

  useEffect(() => {
    setApproved(isToolsetApproved(jigId, stableTools))
  }, [jigId, signature, stableTools])

  const approve = useCallback(() => {
    approveToolset(jigId, stableTools)
    setApproved(true)
  }, [jigId, stableTools])

  return {
    approved,
    reviewRequired: signature.length > 0 && !approved,
    signature,
    approve,
  }
}
