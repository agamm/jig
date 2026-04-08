import { useState, useCallback, useRef, useEffect } from "react";
import type { RunStep, RunStepsMode } from "@/components/run-steps";
import { cancelActiveRun, fetchRunStatus, startJigRun } from "@/lib/api";
import { useDetectActiveRun } from "@/lib/swr";
import type { RunDetail, RunStatus } from "@shared/api";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function toRunSteps(data: Pick<RunDetail, "steps">): RunStep[] {
  return data.steps.map((step, idx) => ({
    num: idx + 1,
    name: step.label,
    status: step.status,
    connections: step.connections,
    output: step.output ?? undefined,
    time: step.status === "running" ? undefined : step.time,
  }))
}

function matchesTarget(data: { jigId?: string }, jigId: string): boolean {
  return data.jigId === jigId
}

export function useJigRun(jigId: string) {
  const [mode, setMode] = useState<RunStepsMode>({ type: "idle" });
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  const [completedTools, setCompletedTools] = useState<string[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [toolReadOnly, setToolReadOnly] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runIdRef = useRef<number | null>(null);
  const [attached, setAttached] = useState(false);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    runIdRef.current = null;
    setAttached(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const pollUntilDone = useCallback(async (runId: number, abort: AbortController, startTime: number, isDryRun: boolean) => {
    // Tick elapsed time
    timerRef.current = setInterval(() => {
      if (!abort.signal.aborted) {
        setMode(prev => prev.type === "running" ? { ...prev, elapsed: Math.round((Date.now() - startTime) / 1000) } : prev);
      }
    }, 1000);

    for (let i = 0; i < 300 && !abort.signal.aborted; i++) {
      // First iteration: fetch immediately (no delay) so we show state on attach
      if (i > 0) await new Promise(r => setTimeout(r, 1000));
      if (abort.signal.aborted) return;

      try {
        const data = await fetchRunStatus(runId);
        if (runIdRef.current !== runId || abort.signal.aborted) return;

        setLiveSteps(toRunSteps(data));
        setCompletedTools(data.completedTools ?? []);
        setActiveTools(data.activeTools ?? []);
        setToolReadOnly(data.readOnly ?? {});

        if (data.status !== "running") {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          runIdRef.current = null;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          setMode({
            type: "done",
            elapsed,
            dryRun: isDryRun,
            status: data.status === "fail" ? "fail" : "success",
            error: data.error ?? undefined,
          });
          return;
        }
      } catch (e: any) {
        if (abort.signal.aborted) return;
      }
    }

    if (!abort.signal.aborted) {
      clearInterval(timerRef.current!);
      timerRef.current = null;
      runIdRef.current = null;
      setMode(prev => prev.type === "running"
        ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail", error: "Timed out" }
        : prev
      );
    }
  }, []);

  // SWR polls for any active run (initial, webhook-triggered, cron-triggered).
  // Once we attach our own poll loop, SWR pauses to avoid double-polling.
  const { data: activeRunData } = useDetectActiveRun(jigId, { paused: attached });
  useEffect(() => {
    if (!activeRunData?.active || !activeRunData.runId) return;
    // Already tracking this or another run — skip
    if (runIdRef.current !== null) return;

    const abort = new AbortController();
    abortRef.current = abort;
    runIdRef.current = activeRunData.runId;
    setAttached(true);
    setMode({ type: "running", elapsed: 0, dryRun: activeRunData.dryRun === true });
    setCompletedTools(activeRunData.completedTools ?? []);
    setActiveTools(activeRunData.activeTools ?? []);
    if (activeRunData.readOnly) setToolReadOnly(activeRunData.readOnly);
    // Let pollUntilDone fetch the full RunDetail (with step timing) on its first tick
    pollUntilDone(activeRunData.runId, abort, Date.now(), activeRunData.dryRun === true);
  }, [activeRunData, pollUntilDone]);

  const startRun = useCallback(async (dryRun: boolean, params?: Record<string, string>) => {
    cleanup();
    const abort = new AbortController();
    abortRef.current = abort;

    setMode({ type: "running", elapsed: 0, dryRun });
    setLiveSteps([]);
    setActiveTools([]);
    setCompletedTools([]);
    setToolReadOnly({});
    const startTime = Date.now();

    try {
      const data = await startJigRun(jigId, { dryRun, params });
      runIdRef.current = data.runId;
      setAttached(true);
      await pollUntilDone(data.runId, abort, startTime, dryRun);
    } catch (e: any) {
      if (abort.signal.aborted) return;
      setMode({ type: "done", elapsed: Math.round((Date.now() - startTime) / 1000), dryRun, status: "fail", error: e?.message ?? "Unknown error" });
    }
  }, [jigId, cleanup, pollUntilDone]);

  const dismiss = useCallback(() => {
    runIdRef.current = null;
    setMode({ type: "idle" });
    setLiveSteps([]);
    setCompletedTools([]);
    setActiveTools([]);
    setToolReadOnly({});
  }, []);

  const cancelRun = useCallback(async () => {
    cleanup();
    try { await cancelActiveRun(jigId); } catch {}
    setMode(prev => prev.type === "running"
      ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail" }
      : prev
    );
    setLiveSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "fail" } : s));
    setActiveTools([]);
}, [cleanup, jigId]);

  return { mode, liveSteps, completedTools, activeTools, toolReadOnly, startRun, dismiss, cancelRun, isRunning: mode.type === "running" };
}
