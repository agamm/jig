import { useState, useCallback, useRef, useEffect } from "react";
import type { RunStep, RunStepsMode } from "@/components/run-steps";

export function useJigRun(jigId: string, entity?: string | null) {
  const [mode, setMode] = useState<RunStepsMode>({ type: "idle" });
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  const [completedTools, setCompletedTools] = useState<string[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /** Poll /api/runs/active until the run finishes. Shared by mount recovery and startRun. */
  const pollUntilDone = useCallback(async (abort: AbortController, startTime: number, isDryRun: boolean) => {
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
        const res = await fetch("/api/runs/active", { signal: abort.signal });
        if (!res.ok) continue;
        const data = await res.json();

        if (!data.active) {
          // Run finished
          clearInterval(timerRef.current!);
          const status = data.status === "fail" ? "fail" : "success";
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          setMode({ type: "done", elapsed, dryRun: isDryRun, status, error: data.error });

          // Fetch final steps for real runs
          if (data.runId > 0) {
            try {
              const finalRes = await fetch(`/api/runs/${data.runId}`, { signal: abort.signal });
              if (finalRes.ok) {
                const run = await finalRes.json();
                if (run.steps?.length) {
                  setLiveSteps(run.steps.map((s: any, idx: number) => ({
                    num: idx + 1, name: s.label, status: s.status,
                    time: s.time, output: s.output ?? undefined,
                  })));
                }
              }
            } catch {}
          }
          return;
        }

        setCompletedTools(data.completedTools ?? []);
        setActiveTools(data.activeTools ?? []);
      } catch (e: any) {
        if (abort.signal.aborted) return;
      }
    }

    if (!abort.signal.aborted) {
      clearInterval(timerRef.current!);
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
        const res = await fetch("/api/runs/active");
        if (!res.ok) return;
        const data = await res.json();
        if (data.active && data.runId) {
          const abort = new AbortController();
          abortRef.current = abort;
          setMode({ type: "running", elapsed: 0, dryRun: false });
          setCompletedTools(data.completedTools ?? []);
          setActiveTools(data.activeTools ?? []);
          await pollUntilDone(abort, Date.now(), false);
        }
      } catch {}
    })();
  }, [pollUntilDone]);

  const startRun = useCallback(async (dryRun: boolean, params?: Record<string, string>) => {
    cleanup();
    const abort = new AbortController();
    abortRef.current = abort;

    setMode({ type: "running", elapsed: 0, dryRun });
    setLiveSteps([]);
    setActiveTools([]);
    setCompletedTools([]);
    const startTime = Date.now();

    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jigId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: entity ?? undefined, dryRun, params }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMode({ type: "done", elapsed: 0, dryRun, status: "fail", error: err.error ?? `HTTP ${res.status}` });
        return;
      }

      await pollUntilDone(abort, startTime, dryRun);
    } catch (e: any) {
      if (abort.signal.aborted) return;
      setMode({ type: "done", elapsed: Math.round((Date.now() - startTime) / 1000), dryRun, status: "fail", error: e?.message ?? "Unknown error" });
    }
  }, [jigId, entity, cleanup, pollUntilDone]);

  const dismiss = useCallback(() => {
    setMode({ type: "idle" });
    setLiveSteps([]);
    setCompletedTools([]);
    setActiveTools([]);
  }, []);

  const cancelRun = useCallback(async () => {
    cleanup();
    try { await fetch("/api/runs/cancel", { method: "POST" }); } catch {}
    setMode(prev => prev.type === "running"
      ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail" }
      : prev
    );
  }, [cleanup]);

  return { mode, liveSteps, completedTools, activeTools, startRun, dismiss, cancelRun, isRunning: mode.type === "running" };
}
