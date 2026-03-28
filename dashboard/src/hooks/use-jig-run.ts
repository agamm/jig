import { useState, useCallback, useRef, useEffect } from "react";
import type { RunStep, RunStepsMode } from "@/components/run-steps";

export function useJigRun(jigId: string, entity?: string | null) {
  const [mode, setMode] = useState<RunStepsMode>({ type: "idle" });
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  const [completedTools, setCompletedTools] = useState<string[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Clean up interval + abort polling on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Check for in-progress run on mount (survives page refresh)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/runs/active");
        if (!res.ok) return;
        const data = await res.json();
        if (data.active && data.runId) {
          setMode({ type: "running", elapsed: 0, dryRun: false });
          setCompletedTools(data.completedTools ?? []);
          setActiveTools(data.activeTools ?? []);
          // Resume polling
          const abort = new AbortController();
          abortRef.current = abort;
          const startTime = Date.now();
          timerRef.current = setInterval(() => {
            if (!abort.signal.aborted) setMode(prev => prev.type === "running" ? { ...prev, elapsed: Math.round((Date.now() - startTime) / 1000) } : prev);
          }, 1000);
          for (let i = 0; i < 300 && !abort.signal.aborted; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (abort.signal.aborted) return;
            try {
              const pollRes = await fetch("/api/runs/active", { signal: abort.signal });
              if (!pollRes.ok) continue;
              const poll = await pollRes.json();
              if (!poll.active) {
                clearInterval(timerRef.current!);
                setMode({ type: "done", elapsed: Math.round((Date.now() - startTime) / 1000), dryRun: false, status: "success" });
                return;
              }
              setCompletedTools(poll.completedTools ?? []);
              setActiveTools(poll.activeTools ?? []);
            } catch (e: any) { if (abort.signal.aborted) return; }
          }
        }
      } catch {}
    })();
  }, []);

  const startRun = useCallback(async (dryRun: boolean, params?: Record<string, string>) => {
    // Abort any previous run's polling
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setMode({ type: "running", elapsed: 0, dryRun });
    setLiveSteps([]);
    setActiveTools([]);
    const startTime = Date.now();

    // Tick elapsed
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (abort.signal.aborted) return;
      setMode(prev => prev.type === "running" ? { ...prev, elapsed: Math.round((Date.now() - startTime) / 1000) } : prev);
    }, 1000);

    const done = (status: "success" | "fail", elapsed: number, error?: string) => {
      clearInterval(timerRef.current!);
      if (!abort.signal.aborted) {
        setMode({ type: "done", elapsed, dryRun, status, error });
      }
    };

    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jigId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: entity ?? undefined, dryRun, params }),
        signal: abort.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        done("fail", Math.round((Date.now() - startTime) / 1000), err.error ?? `HTTP ${res.status}`);
        return;
      }
      const { runId } = await res.json();

      // Poll for completion
      for (let i = 0; i < 300 && !abort.signal.aborted; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (abort.signal.aborted) return;
        try {
          // Poll active endpoint — works for both real runs and dry runs
          const pollRes = await fetch("/api/runs/active", { signal: abort.signal });
          if (!pollRes.ok) continue;
          const data = await pollRes.json();

          if (!data.active) {
            // Run finished — fetch final result if it was a real run
            if (runId > 0) {
              try {
                const finalRes = await fetch(`/api/runs/${runId}`, { signal: abort.signal });
                if (finalRes.ok) {
                  const run = await finalRes.json();
                  if (run.steps?.length) {
                    setLiveSteps(run.steps.map((s: any, idx: number) => ({
                      num: idx + 1, name: s.label, status: s.status,
                      time: s.time, output: s.output ?? undefined,
                    })));
                  }
                  done(run.status, run.durationMs ? Math.round(run.durationMs / 1000) : Math.round((Date.now() - startTime) / 1000), run.error ?? undefined);
                  return;
                }
              } catch {}
            }
            done("success", Math.round((Date.now() - startTime) / 1000));
            return;
          }

          setCompletedTools(data.completedTools ?? []);
          setActiveTools(data.activeTools ?? []);
        } catch (e: any) {
          if (abort.signal.aborted) return;
          console.warn("Poll error:", e?.message);
        }
      }
      if (!abort.signal.aborted) done("fail", Math.round((Date.now() - startTime) / 1000), "Timed out");
    } catch (e: any) {
      if (abort.signal.aborted) return;
      done("fail", Math.round((Date.now() - startTime) / 1000), e?.message ?? "Unknown error");
    }
  }, [jigId, entity]);

  const dismiss = useCallback(() => {
    setMode({ type: "idle" });
    setLiveSteps([]);
    setCompletedTools([]);
    setActiveTools([]);
  }, []);

  const cancelRun = useCallback(async () => {
    abortRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    try { await fetch("/api/runs/cancel", { method: "POST" }); } catch {}
    setMode(prev => prev.type === "running"
      ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail" }
      : prev
    );
  }, []);

  const isRunning = mode.type === "running";

  return { mode, liveSteps, completedTools, activeTools, startRun, dismiss, cancelRun, isRunning };
}
