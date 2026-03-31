"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { JigToolDto } from "@shared/api"

const STORAGE_KEY = "jig-tool-approvals-v1"

function normalizeTools(tools: JigToolDto[]): JigToolDto[] {
  return [...tools]
    .sort((a, b) =>
      `${a.connection}:${a.name}:${a.readOnly}`.localeCompare(`${b.connection}:${b.name}:${b.readOnly}`)
    )
}

export function getToolsetSignature(tools: JigToolDto[]): string {
  return normalizeTools(tools)
    .map((tool) => `${tool.connection}:${tool.name}:${tool.readOnly ? "ro" : "rw"}`)
    .join("|")
}

function getApprovalKey(jigId: string, entity: string | null | undefined, signature: string): string {
  return `${jigId}::${entity ?? ""}::${signature}`
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

export function isToolsetApproved(jigId: string, entity: string | null | undefined, tools: JigToolDto[]): boolean {
  if (tools.length === 0) return true
  const signature = getToolsetSignature(tools)
  if (!signature) return true
  const store = readApprovalStore()
  return store[getApprovalKey(jigId, entity, signature)] === true
}

export function approveToolset(jigId: string, entity: string | null | undefined, tools: JigToolDto[]) {
  if (tools.length === 0) return
  const signature = getToolsetSignature(tools)
  if (!signature) return
  const store = readApprovalStore()
  store[getApprovalKey(jigId, entity, signature)] = true
  writeApprovalStore(store)
}

export function useJigToolApproval(jigId: string, entity: string | null | undefined, tools: JigToolDto[]) {
  const signature = useMemo(() => getToolsetSignature(tools), [tools])
  const [approved, setApproved] = useState<boolean>(() => isToolsetApproved(jigId, entity, tools))

  useEffect(() => {
    setApproved(isToolsetApproved(jigId, entity, tools))
  }, [entity, jigId, signature, tools])

  const approve = useCallback(() => {
    approveToolset(jigId, entity, tools)
    setApproved(true)
  }, [entity, jigId, tools])

  return {
    approved,
    reviewRequired: tools.length > 0 && !approved,
    signature,
    approve,
  }
}
