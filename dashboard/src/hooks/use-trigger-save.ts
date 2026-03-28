import { useState, useEffect, useRef } from "react"
import { toast } from "@/components/toast"

export function useTriggerSave(jigId: string, serverTrigger: string) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(serverTrigger)
  const [display, setDisplay] = useState(serverTrigger)
  const [saving, setSaving] = useState(false)
  const savedLocally = useRef(false)

  // Sync when parent prop changes (e.g. jig list re-fetch)
  useEffect(() => {
    if (savedLocally.current) { savedLocally.current = false; return }
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
        savedLocally.current = true
        setDisplay(data.trigger)
        setValue(data.trigger)
        if (data.warning) {
          toast.info(`Set to "${data.trigger}" — ${data.warning}`)
        } else {
          toast.success(`Trigger updated to "${data.trigger}"`)
        }
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
