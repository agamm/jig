import { useState, useEffect } from "react"
import { toast } from "@/components/toast"

export function useTriggerSave(jigId: string, serverTrigger: string) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(serverTrigger)
  const [display, setDisplay] = useState(serverTrigger)
  const [saving, setSaving] = useState(false)

  // Sync when parent prop changes (e.g. jig list re-fetch)
  useEffect(() => {
    setDisplay(serverTrigger)
    if (!editing) setValue(serverTrigger)
  }, [serverTrigger, editing])

  const startEditing = () => { setEditing(true); setValue(display) }
  const cancel = () => { setEditing(false); setValue(display) }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jigId)}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: value }),
      })
      const data = await res.json()
      if (data.ok) {
        setDisplay(data.trigger)
        setValue(data.trigger)
        toast.success(`Trigger updated to "${data.trigger}"`)
      } else {
        toast.error(data.error || "Failed to save trigger")
      }
    } catch {
      toast.error("Failed to save trigger")
    }
    setSaving(false)
    setEditing(false)
  }

  return { editing, value, setValue, display, saving, save, startEditing, cancel }
}
