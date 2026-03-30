import { useState, useEffect, useRef } from "react"
import { toast } from "@/components/toast"
import { updateJigTrigger } from "@/lib/api"

export function useTriggerSave(jigId: string, serverTrigger: string, entity?: string | null) {
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
      const data = await updateJigTrigger(jigId, value, entity)
      savedLocally.current = true
      setDisplay(data.trigger)
      setValue(data.trigger)
      if (data.warning) {
        toast.info(`Set to "${data.trigger}" — ${data.warning}`)
      } else {
        toast.success(`Trigger updated to "${data.trigger}"`)
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save trigger")
    }
    setSaving(false)
    setEditing(false)
  }

  return { editing, value, setValue, display, saving, save, startEditing, cancel }
}
