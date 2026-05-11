import { useState, useCallback, useRef, useEffect } from "react";
import { mutate as mutateCache } from "swr";
import type { RunStep, RunStepsMode } from "@/components/run-steps";
import { cancelActiveRun, fetchRunStatus, startJigRun } from "@/lib/api";
import { useDetectActiveRun } from "@/lib/swr";
import type { RunDetail, RunStatus } from "@shared/api";

const MIN_DRY_RUN_VISIBLE_MS = 500;

function toRunSteps(data: Pick<RunDetail, "steps" | "output">): RunStep[] {
  const steps = data.steps.map((step, idx) => ({
    num: idx + 1,
    name: step.label,
    status: step.status,
    connections: step.connections,
    output: step.output ?? undefined,
    time: step.status === "running" ? undefined : step.time,
  }))
  const fallbackOutput = data.output?.trim()
  if (fallbackOutput && steps.length > 0 && !steps.some((step) => step.output?.trim())) {
    steps[steps.length - 1] = {
      ...steps[steps.length - 1],
      output: fallbackOutput,
    }
  }
  return steps
}

function activeRunKey(jigId: string) {
  return `jig/${jigId}/active-run`
}

function toActiveRunSteps(data: Pick<RunStatus, "steps">): RunStep[] {
  return (data.steps ?? []).map((step) => ({
    num: step.seq,
    name: step.label,
    status: step.status,
    connections: step.connections,
    output: step.output ?? undefined,
  }))
}

function isTerminalRunDetailError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Run not found|HTTP 404/i.test(message)
}

async function ensureMinimumVisibleRun(startTime: number, abort: AbortController, dryRun: boolean) {
  if (!dryRun) return;
  const remaining = MIN_DRY_RUN_VISIBLE_MS - (Date.now() - startTime);
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, remaining));
  if (abort.signal.aborted) return;
}

type MissingConnectionsHandler = (connections: string[]) => void;

function extractMissingConnections(error: any): string[] {
  const required = error?.details?.requiredConnections;
  if (Array.isArray(required)) return required.filter((name): name is string => typeof name === "string");
  const statuses = error?.details?.connectionStatuses;
  if (Array.isArray(statuses)) {
    return statuses
      .filter((item: any) => item && item.connected !== true && typeof item.name === "string")
      .map((item: any) => item.name);
  }
  return [];
}

export function useJigRun(jigId: string, options: { onMissingConnections?: MissingConnectionsHandler } = {}) {
  const { onMissingConnections } = options;
  const [mode, setMode] = useState<RunStepsMode>({ type: "idle" });
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  const [completedTools, setCompletedTools] = useState<string[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [toolReadOnly, setToolReadOnly] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runIdRef = useRef<number | null>(null);
  const liveStepsRef = useRef<RunStep[]>([]);
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    liveStepsRef.current = liveSteps;
  }, [liveSteps]);

  const setInactiveSnapshot = useCallback(() => {
    void mutateCache(activeRunKey(jigId), { active: false, jigId, steps: [] }, false);
  }, [jigId]);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    runIdRef.current = null;
    setAttached(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const pollUntilDone = useCallback(async (runId: number, abort: AbortController, startTime: number, isDryRun: boolean) => {
    if (abort.signal.aborted) return;

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
          await ensureMinimumVisibleRun(startTime, abort, isDryRun);
          if (runIdRef.current !== runId || abort.signal.aborted) return;
          clearInterval(timerRef.current!);
          timerRef.current = null;
          runIdRef.current = null;
          setAttached(false);
          setInactiveSnapshot();
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

        void mutateCache(activeRunKey(jigId), {
          active: true,
          runId,
          jigId,
          dryRun: isDryRun,
          startedAt: startTime,
          completedTools: data.completedTools ?? [],
          activeTools: data.activeTools ?? [],
          readOnly: data.readOnly ?? {},
          steps: data.steps ?? [],
          status: "running",
          output: data.output ?? undefined,
        }, false);
      } catch (e: any) {
        if (abort.signal.aborted) return;
        if (!isTerminalRunDetailError(e)) continue;

        clearInterval(timerRef.current!);
        timerRef.current = null;
        runIdRef.current = null;
        setAttached(false);
        setInactiveSnapshot();

        const hadSteps = liveStepsRef.current.length > 0;
        if (hadSteps) {
          setMode((prev) => prev.type === "running"
            ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail", error: e?.message ?? "Run not found" }
            : prev
          );
        } else {
          setMode({ type: "idle" });
          setLiveSteps([]);
          setCompletedTools([]);
          setActiveTools([]);
          setToolReadOnly({});
        }
        return;
      }
    }

    if (!abort.signal.aborted) {
      clearInterval(timerRef.current!);
      timerRef.current = null;
      runIdRef.current = null;
      setAttached(false);
      setInactiveSnapshot();
      setMode(prev => prev.type === "running"
        ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail", error: "Timed out" }
        : prev
      );
    }
  }, [jigId, setInactiveSnapshot]);

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
    setLiveSteps(toActiveRunSteps(activeRunData));
    setCompletedTools(activeRunData.completedTools ?? []);
    setActiveTools(activeRunData.activeTools ?? []);
    if (activeRunData.readOnly) setToolReadOnly(activeRunData.readOnly);
    // Let pollUntilDone fetch the full RunDetail (with step timing) on its first tick
    pollUntilDone(activeRunData.runId, abort, activeRunData.startedAt ?? Date.now(), activeRunData.dryRun === true);
  }, [activeRunData, pollUntilDone]);

  const startRun = useCallback(async (dryRun: boolean) => {
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
      const data = await startJigRun(jigId, { dryRun });
      if (abort.signal.aborted) return;
      runIdRef.current = data.runId;
      setAttached(true);
      void mutateCache(activeRunKey(jigId), {
        active: true,
        runId: data.runId,
        jigId,
        dryRun,
        startedAt: startTime,
        completedTools: [],
        activeTools: [],
        readOnly: {},
        steps: [],
        status: "running",
      }, false);
      await pollUntilDone(data.runId, abort, startTime, dryRun);
    } catch (e: any) {
      if (abort.signal.aborted) return;
      const missingConnections = extractMissingConnections(e);
      if (missingConnections.length > 0) {
        onMissingConnections?.(missingConnections);
      }
      setAttached(false);
      setInactiveSnapshot();
      setMode({ type: "done", elapsed: Math.round((Date.now() - startTime) / 1000), dryRun, status: "fail", error: e?.message ?? "Unknown error" });
    }
  }, [jigId, cleanup, pollUntilDone, setInactiveSnapshot, onMissingConnections]);

  const dismiss = useCallback(() => {
    runIdRef.current = null;
    setAttached(false);
    setInactiveSnapshot();
    setMode({ type: "idle" });
    setLiveSteps([]);
    setCompletedTools([]);
    setActiveTools([]);
    setToolReadOnly({});
  }, [setInactiveSnapshot]);

  const cancelRun = useCallback(async () => {
    cleanup();
    try { await cancelActiveRun(jigId); } catch {}
    setInactiveSnapshot();
    setMode(prev => prev.type === "running"
      ? { type: "done", elapsed: prev.elapsed, dryRun: prev.dryRun, status: "fail" }
      : prev
    );
    setLiveSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "fail" } : s));
    setActiveTools([]);
}, [cleanup, jigId, setInactiveSnapshot]);

  return {
    mode,
    liveSteps,
    completedTools,
    activeTools,
    toolReadOnly,
    startRun,
    dismiss,
    cancelRun,
    isRunning: mode.type === "running",
    canCancel: attached,
  };
}
