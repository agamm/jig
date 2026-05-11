"use client";

import { useEffect, useState } from "react";
import { mutate } from "swr";
import { Button } from "@/components/button";
import { TextInput } from "@/components/input";
import { LoadingState, Notice } from "@/components/state-panel";
import { saveSystemSettings } from "@/lib/api";
import { useSystemSettings } from "@/lib/swr";

function isLikelyTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function SystemSettings() {
  const { data: settings, error, isLoading } = useSystemSettings();
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  useEffect(() => {
    if (settings?.timezone) setTimezone(settings.timezone);
  }, [settings?.timezone]);

  async function onSave() {
    const next = timezone.trim();
    setStatus(null);
    if (!isLikelyTimeZone(next)) {
      setStatus({ tone: "danger", message: "Use an IANA timezone like America/Chicago." });
      return;
    }
    setSaving(true);
    try {
      const saved = await saveSystemSettings({ timezone: next });
      setTimezone(saved.timezone);
      await Promise.all([mutate("system-settings"), mutate("jigs")]);
      setStatus({ tone: "success", message: `Scheduler timezone saved as ${saved.timezone}. Existing cron schedules were recalculated.` });
    } catch (e) {
      setStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !settings) return <LoadingState message="Loading system settings..." />;

  return (
    <div className="space-y-4">
      {error && <Notice tone="danger">Could not load system settings: {error.message}</Notice>}
      <section className="rounded-xl border border-[#1f1f23] bg-[#111113] p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-md">
            <p className="text-[13px] font-semibold text-[#ededed]">Scheduler timezone</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#666]">
              Cron triggers are evaluated in this timezone. `jig deploy` seeds this from the deploying computer, then Jig stores it in SQLite.
            </p>
          </div>
          <div className="w-full sm:w-72">
            <TextInput
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="America/Chicago"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="mt-1 text-[10px] text-[#555]">Current browser timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}</p>
          </div>
        </div>
        {status && <Notice tone={status.tone} className="mt-4">{status.message}</Notice>}
        <div className="mt-4 flex justify-end">
          <Button
            onClick={onSave}
            disabled={saving || timezone.trim() === settings.timezone}
            variant="successOutline"
            size="sm"
          >
            {saving ? "Saving..." : "Save timezone"}
          </Button>
        </div>
      </section>
    </div>
  );
}
