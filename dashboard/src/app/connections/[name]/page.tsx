"use client"

import { useParams, useRouter } from "next/navigation"
import { ConnectionPane } from "@/components/connection-pane"

export default function ConnectionPage() {
  const params = useParams<{ name: string }>()
  const router = useRouter()

  return (
    <div className="flex h-full" style={{ background: "#0a0a0b" }}>
      <ConnectionPane
        name={params.name}
        onClose={() => router.push("/")}
        onJigClick={(jigId) => router.push("/")}
        standalone
      />
    </div>
  )
}
