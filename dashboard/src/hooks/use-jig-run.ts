import { useState, useCallback, useRef, useEffect } from "react";
import type { RunStep, RunStepsMode } from "@/components/run-steps";
import { cancelActiveRun, fetchActiveRun, fetchRunStatus, startJigRun } from "@/lib/api";
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

function matchesTarget(data: { jigId?: string; entity?: string | null }, jigId: string, entity?: string | null): boolean {
  return data.jigId === jigId && (data.entity ?? null) === (entity ?? null)
}

export function useJigRun(jigId: string, entity?: string | null) {
  const [mode, setMode] = useState<RunStepsMode>({ type: "idle" });
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  const [completedTools, setCompletedTools] = useState<string[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [toolReadOnly, setToolReadOnly] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runIdRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    runIdRef.current = null;
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
      await new Promise(r => setTimeout(r, 1000));
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

  // Check for in-progress run on mount (survives page refresh)
  useEffect(() => {
    (async () => {
      try {
        const data: RunStatus = await fetchActiveRun();
        if (data.active && data.runId && matchesTarget(data, jigId, entity)) {
          const abort = new AbortController();
          abortRef.current = abort;
          runIdRef.current = data.runId;
          setMode({ type: "running", elapsed: 0, dryRun: data.dryRun === true });
          setCompletedTools(data.completedTools ?? []);
          setActiveTools(data.activeTools ?? []);
          if (data.readOnly) setToolReadOnly(data.readOnly);
          await pollUntilDone(data.runId, abort, Date.now(), data.dryRun === true);
        }
      } catch {}
    })();
  }, [entity, jigId, pollUntilDone]);

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
      const data = await startJigRun(jigId, { entity: entity ?? undefined, dryRun, params });
      runIdRef.current = data.runId;
      await pollUntilDone(data.runId, abort, startTime, dryRun);
    } catch (e: any) {
      if (abort.signal.aborted) return;
      setMode({ type: "done", elapsed: Math.round((Date.now() - startTime) / 1000), dryRun, status: "fail", error: e?.message ?? "Unknown error" });
    }
  }, [jigId, entity, cleanup, pollUntilDone]);

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
    try { await cancelActiveRun(); } catch {}
    setMode(prev => prev.type === "running"
      ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail" }
      : prev
    );
    setLiveSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "fail" } : s));
    setActiveTools([]);
}, [cleanup]);

  return { mode, liveSteps, completedTools, activeTools, toolReadOnly, startRun, dismiss, cancelRun, isRunning: mode.type === "running" };
}
