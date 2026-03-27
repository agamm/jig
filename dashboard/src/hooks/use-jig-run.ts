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

  const startRun = useCallback(async (dryRun: boolean) => {
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
        body: JSON.stringify({ entity: entity ?? undefined, dryRun }),
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
          const pollRes = await fetch(`/api/runs/${runId}`, { signal: abort.signal });
          if (!pollRes.ok) continue;
          const run = await pollRes.json();

          if (run.steps?.length) {
            setLiveSteps(run.steps.map((s: any, idx: number) => ({
              num: idx + 1,
              name: s.label,
              status: s.status,
              time: s.time,
              output: s.output ?? undefined,
            })));
          }
          setCompletedTools(run.completedTools ?? []);
          setActiveTools(run.activeTools ?? []);

          if (run.status === "success" || run.status === "fail") {
            const elapsed = run.durationMs ? Math.round(run.durationMs / 1000) : Math.round((Date.now() - startTime) / 1000);
            done(run.status, elapsed, run.error ?? undefined);
            return;
          }
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

  const isRunning = mode.type === "running";

  return { mode, liveSteps, completedTools, activeTools, startRun, dismiss, isRunning };
}
