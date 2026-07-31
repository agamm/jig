"use client"

import { useMemo, useState } from "react"
import type { JigTool, ToolPermission } from "@shared/api"
import { saveToolPermission } from "./api"
import { getToolsetSignature, normalizeTools } from "./toolset-signature"

function allowedToolKeys(permissions: ToolPermission[]): Set<string> {
  return new Set(
    permissions
      .filter((permission) => permission.policy === "always")
      .map((permission) => `${permission.connection}:${permission.tool}`)
  )
}

export function useJigToolApproval(tools: JigTool[], permissions: ToolPermission[], onApproved?: () => Promise<void> | void) {
  const signature = useMemo(() => getToolsetSignature(tools), [tools])
  const stableTools = useMemo(() => normalizeTools(tools), [signature])
  const approvedToolKeys = useMemo(() => allowedToolKeys(permissions), [permissions])
  const approved = stableTools.every((tool) => approvedToolKeys.has(`${tool.connection}:${tool.name}`))
  const [saving, setSaving] = useState(false)

  async function approve() {
    if (stableTools.length === 0) return
    setSaving(true)
    try {
      await Promise.all(stableTools.map((tool) => saveToolPermission({
        connection: tool.connection,
        tool: tool.name,
        policy: "always",
      })))
      await onApproved?.()
    } finally {
      setSaving(false)
    }
  }

  return {
    approved,
    reviewRequired: signature.length > 0 && !approved,
    signature,
    approve,
    saving,
  }
}
