"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mutate } from "swr";
import { Button } from "@/components/button";
import { LoadingState, Notice } from "@/components/state-panel";
import { fetchOpenRouterCatalog, updateModels } from "@/lib/api";
import { useModels } from "@/lib/swr";
import type {
  ModelCatalog,
  ModelSlot,
  OpenRouterCatalogResponse,
  OpenRouterModelInfo,
} from "@shared/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey = "blended" | "listed" | "context" | "name" | "prompt" | "completion" | "recency";
type SortDir = "asc" | "desc";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  blended: "asc",
  prompt: "asc",
  completion: "asc",
  listed: "asc",
  context: "desc",
  name: "asc",
  recency: "desc",
};

const SORT_LABELS: Record<SortKey, string> = {
  blended: "Price",
  listed: "Listed",
  context: "Context",
  name: "Name",
  prompt: "$ in",
  completion: "$ out",
  recency: "Newest",
};

const SLOT_ORDER: ModelSlot[] = ["main", "fast"];
const PRICE_CEILING_USD_PER_M = 5;
const FAST_PRICE_CEILING_USD_PER_M = 1;

export const SLOT_META: Record<ModelSlot, { label: string; hint: string }> = {
  main: {
    label: "Main",
    hint: `Most popular agentic workflow models — tool-calling required, under $${PRICE_CEILING_USD_PER_M}/M blended.`,
  },
  fast: {
    label: "Fast",
    hint: `Throughput-optimized & cheap. :nitro variants first, then most popular under $${FAST_PRICE_CEILING_USD_PER_M}/M blended.`,
  },
};

// ---------------------------------------------------------------------------
// Pure helpers — API-only, no brand/name regex
// ---------------------------------------------------------------------------

export function fmtPrice(usdPerM: number): string {
  if (usdPerM === 0) return "free";
  if (usdPerM < 0.01) return `$${usdPerM.toFixed(4)}`;
  return `$${usdPerM.toFixed(2)}`;
}

export function fmtContext(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Provider prefix from id — e.g. "anthropic/claude-haiku-4.5" → "anthropic". */
function provider(id: string): string {
  return id.split("/")[0] ?? id;
}

/** OpenRouter convention: :nitro suffix = throughput-optimized endpoint. */
function isNitro(id: string): boolean {
  return id.endsWith(":nitro");
}

// ---------------------------------------------------------------------------
// Role scoring — purely from API-provided fields
//
// Main:   from a foundational lab, must call tools, blended price < $5, not free.
// Fast:   blended price < $1; :nitro variants get a strong boost.
// Release date (`createdAt`) orders what is left, so newer generations rise.
//
// These used to rank on `catalogOrder`, i.e. position in OpenRouter's /models
// response, under the belief it meant popularity. It does not: the listing is
// newest-first and OpenRouter publishes no usage figure through its public API.
// The effect was that whichever obscure vendor had published most recently
// scored highest and became the recommendation.
// ---------------------------------------------------------------------------

// Vendors whose models may be recommended. Mirrors FOUNDATIONAL_PROVIDERS in
// src/services/model-upgrade.ts; keep the two in step.
const FOUNDATIONAL_PROVIDERS = new Set([
  "anthropic", "openai", "google", "meta-llama", "meta", "mistralai",
  "x-ai", "deepseek", "qwen", "microsoft", "amazon", "cohere",
]);

function isFoundational(id: string): boolean {
  return FOUNDATIONAL_PROVIDERS.has(id.split("/")[0]?.replace(/^~/, "") ?? "");
}

/** Newer is better, and only known labs are eligible at all. */
function baseScore(m: OpenRouterModelInfo): number {
  if (!isFoundational(m.id)) return -Infinity;
  return (m.createdAt ?? 0) / 1e6;
}

function scoreMain(m: OpenRouterModelInfo): number {
  if (!m.supportsTools) return -Infinity;
  if (m.blendedPriceUsdPerM <= 0) return -Infinity;
  if (m.blendedPriceUsdPerM >= PRICE_CEILING_USD_PER_M) return -Infinity;
  return baseScore(m);
}

function scoreFast(m: OpenRouterModelInfo): number {
  if (m.blendedPriceUsdPerM <= 0) return -Infinity;
  if (m.blendedPriceUsdPerM >= FAST_PRICE_CEILING_USD_PER_M) return -Infinity;
  let s = baseScore(m);
  if (isNitro(m.id)) s += 50_000;
  return s;
}

const SCORERS: Record<ModelSlot, (m: OpenRouterModelInfo) => number> = {
  main: scoreMain,
  fast: scoreFast,
};

function recommendFor(slot: ModelSlot, models: OpenRouterModelInfo[]): OpenRouterModelInfo[] {
  const scorer = SCORERS[slot];
  const scored = models
    .map((m) => ({ m, score: scorer(m) }))
    .filter(({ score }) => Number.isFinite(score));
  scored.sort((a, b) => b.score - a.score);

  // Diversity: at most one model per provider on the first pass.
  const seen = new Set<string>();
  const out: OpenRouterModelInfo[] = [];
  for (const { m } of scored) {
    const p = provider(m.id);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(m);
    if (out.length === 5) break;
  }
  // Top-up from remaining high-scorers if fewer than 5 providers qualified.
  if (out.length < 5) {
    for (const { m } of scored) {
      if (out.includes(m)) continue;
      out.push(m);
      if (out.length === 5) break;
    }
  }
  return out;
}

/** Short reason line — derived only from API boolean flags and suffix. */
function reasonFor(m: OpenRouterModelInfo): string {
  const bits: string[] = [];
  if (isNitro(m.id)) bits.push("nitro throughput");
  if (m.supportsTools) bits.push("tools");
  if (m.supportsReasoning) bits.push("reasoning");
  if (m.contextLength >= 500_000) bits.push("long ctx");
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// Search / sort for browse-all
// ---------------------------------------------------------------------------

function scoreMatch(m: OpenRouterModelInfo, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const id = m.id.toLowerCase();
  const name = m.name.toLowerCase();
  if (id === q) return 1000;
  if (id.startsWith(q)) return 500;
  if (name.startsWith(q)) return 400;
  if (id.includes(q)) return 200;
  if (name.includes(q)) return 100;
  const parts = q.split(/[\s/]+/).filter(Boolean);
  if (parts.every((p) => id.includes(p) || name.includes(p))) return 50;
  return 0;
}

function sortModels(models: OpenRouterModelInfo[], sort: SortKey, dir: SortDir): OpenRouterModelInfo[] {
  const cmp: Record<SortKey, (a: OpenRouterModelInfo, b: OpenRouterModelInfo) => number> = {
    blended: (a, b) => a.blendedPriceUsdPerM - b.blendedPriceUsdPerM,
    prompt: (a, b) => a.promptPriceUsdPerM - b.promptPriceUsdPerM,
    completion: (a, b) => a.completionPriceUsdPerM - b.completionPriceUsdPerM,
    listed: (a, b) => a.catalogOrder - b.catalogOrder,
    context: (a, b) => a.contextLength - b.contextLength,
    name: (a, b) => a.name.localeCompare(b.name),
    recency: (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  };
  const base = cmp[sort];
  const signed = dir === "asc" ? base : (a: OpenRouterModelInfo, b: OpenRouterModelInfo) => -base(a, b);
  return [...models].sort(signed);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ModelsSettings({ autofocusSlot }: { autofocusSlot?: ModelSlot } = {}) {
  const { data: current, isLoading: modelsLoading } = useModels();
  const [catalog, setCatalog] = useState<OpenRouterCatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<ModelSlot, string>>({ main: "", fast: "" });
  const [activeSlot, setActiveSlot] = useState<ModelSlot>(autofocusSlot ?? "main");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("blended");
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_DIR.blended);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [reasoningOnly, setReasoningOnly] = useState(false);
  const [showFree, setShowFree] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const browseRef = useRef<HTMLDivElement | null>(null);

  function setSortKey(next: SortKey) {
    setSort((prev) => {
      if (prev === next) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir(DEFAULT_DIR[next]);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetchOpenRouterCatalog()
      .then((data) => !cancelled && setCatalog(data))
      .catch((e) => !cancelled && setCatalogError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    setDraft({ main: current.main.id, fast: current.fast.id });
  }, [current]);

  useEffect(() => {
    if (autofocusSlot) setActiveSlot(autofocusSlot);
  }, [autofocusSlot]);

  const dirty = useMemo(() => {
    if (!current) return false;
    return SLOT_ORDER.some((s) => draft[s] !== current[s].id);
  }, [draft, current]);

  const atDefaults = useMemo(() => {
    if (!current?.defaults) return false;
    return SLOT_ORDER.every((s) => draft[s] === current.defaults![s].id);
  }, [draft, current]);

  const recommendations = useMemo(() => {
    if (!catalog) return [];
    return recommendFor(activeSlot, catalog.models);
  }, [catalog, activeSlot]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    let list = catalog.models;
    if (toolsOnly) list = list.filter((m) => m.supportsTools);
    if (reasoningOnly) list = list.filter((m) => m.supportsReasoning);
    if (!showFree) list = list.filter((m) => m.blendedPriceUsdPerM > 0);
    if (query) {
      list = list
        .map((m) => ({ m, score: scoreMatch(m, query) }))
        .filter(({ score }) => score > 0)
        .map(({ m }) => m);
    }
    return sortModels(list, sort, sortDir);
  }, [catalog, query, sort, sortDir, toolsOnly, reasoningOnly, showFree]);

  const catalogById = useMemo(() => {
    const map = new Map<string, OpenRouterModelInfo>();
    if (catalog) for (const m of catalog.models) map.set(m.id, m);
    return map;
  }, [catalog]);

  async function onSave() {
    if (!dirty) return;
    setSaving(true);
    setStatus(null);
    try {
      await updateModels(draft);
      await mutate("models");
      setStatus({ tone: "success", message: "Saved." });
    } catch (e) {
      setStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  function resetToCurrent() {
    if (!current) return;
    setDraft({ main: current.main.id, fast: current.fast.id });
    setStatus(null);
  }

  function resetToDefaults() {
    if (!current?.defaults) return;
    setDraft({
      main: current.defaults.main.id,
      fast: current.defaults.fast.id,
    });
    setStatus(null);
  }

  function pickModel(id: string) {
    setDraft((prev) => ({ ...prev, [activeSlot]: id }));
  }

  if (modelsLoading || !current) {
    return <LoadingState message="Loading model settings…" />;
  }

  const activeDraft = draft[activeSlot];
  const activeSaved = current[activeSlot].id;

  return (
    <div className="flex h-[calc(100vh-180px)] flex-col gap-3">
      {/* Role tab bar — each tab shows role label, current id, price */}
      <div className="flex shrink-0 overflow-hidden rounded-lg border border-[#1f1f23] bg-[#0d0d0f]">
        {SLOT_ORDER.map((slot, i) => {
          const active = activeSlot === slot;
          const slotDraft = draft[slot];
          const slotMeta = catalogById.get(slotDraft);
          const slotDirty = slotDraft !== current[slot].id;
          return (
            <button
              key={slot}
              onClick={() => setActiveSlot(slot)}
              // The bar clips its children, so the global focus ring would be
              // sheared into a hard green edge against the container. Draw it
              // inside the tab instead.
              className={`group flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors focus-visible:shadow-[inset_0_0_0_1px_rgba(16,185,129,0.55)] ${
                i > 0 ? "border-l border-[#1f1f23]" : ""
              } ${active ? "bg-emerald-500/[0.07]" : "hover:bg-[#141416]"}`}
            >
              <span
                className={`text-[10px] font-medium uppercase tracking-[0.14em] ${
                  active ? "text-emerald-200" : "text-[var(--text-dim)]"
                }`}
              >
                {SLOT_META[slot].label}
              </span>
              <span className="mx-1 h-3 w-px bg-[#1f1f23]" />
              <span
                className={`flex-1 truncate font-mono text-[11px] ${active ? "text-emerald-100" : "text-[#ededed]"}`}
                title={slotDraft}
              >
                {slotDraft.split("/").pop()}
              </span>
              {slotMeta ? (
                <span className="shrink-0 font-mono text-[9px] text-[var(--text-faint)]">
                  {fmtPrice(slotMeta.promptPriceUsdPerM)}/{fmtPrice(slotMeta.completionPriceUsdPerM)}
                </span>
              ) : null}
              {slotDirty ? (
                <span className="shrink-0 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-1.5 py-[1px] text-[8px] font-medium uppercase text-amber-200">
                  unsaved
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Hint line */}
      <div className="shrink-0 px-1 text-[11px] text-[var(--text-dim)]">
        <span className="font-medium text-[#ededed]">{SLOT_META[activeSlot].label}:</span>{" "}
        {SLOT_META[activeSlot].hint}
      </div>

      {/* Recommendation rows + browse-all */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {catalogError ? (
          <Notice tone="danger">Couldn’t load OpenRouter catalog: {catalogError}</Notice>
        ) : !catalog ? (
          <div className="text-[11px] text-[var(--text-dim)]">Loading OpenRouter catalog…</div>
        ) : (
          <>
            <div className="flex flex-col">
              {recommendations.map((m, i) => (
                <RecRow
                  key={m.id}
                  model={m}
                  selected={activeDraft === m.id}
                  currentlySaved={activeSaved === m.id}
                  onPick={() => pickModel(m.id)}
                  first={i === 0}
                  last={i === recommendations.length - 1}
                />
              ))}
            </div>

            <div className="mt-3 border-t border-[#1f1f23] pt-3">
              <button
                onClick={() => {
                  setBrowseOpen((v) => !v);
                  if (!browseOpen) {
                    setTimeout(() => {
                      browseRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      searchRef.current?.focus();
                    }, 50);
                  }
                }}
                className="flex w-full items-center gap-2 rounded-md border border-[#1f1f23] bg-[#111113] px-3 py-2 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[#2a2a2e] hover:text-[#ededed]"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`h-3.5 w-3.5 transition-transform ${browseOpen ? "rotate-90" : ""}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className="flex-1 text-left">
                  {browseOpen
                    ? "Hide full catalog"
                    : `Pick something else — browse all ${catalog.models.length} models`}
                </span>
              </button>

              {browseOpen ? (
                <div ref={browseRef} className="mt-3 overflow-hidden rounded-lg border border-[#1f1f23] bg-[#0d0d0f]">
                  <div className="flex flex-col gap-2 border-b border-[#1f1f23] px-3 py-2">
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search by id or name"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="ui-input ui-input-compact font-mono text-[11px]"
                    />
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-[9px] uppercase tracking-wider text-[var(--text-faint)]">Filter</span>
                      <FilterToggle label="Tools" active={toolsOnly} onToggle={() => setToolsOnly(!toolsOnly)} />
                      <FilterToggle
                        label="Reasoning"
                        active={reasoningOnly}
                        onToggle={() => setReasoningOnly(!reasoningOnly)}
                      />
                      <FilterToggle label="Show free" active={showFree} onToggle={() => setShowFree(!showFree)} />
                      <span className="ml-auto text-[9px] text-[var(--text-faint)]">
                        {filtered.length} / {catalog.models.length}
                      </span>
                    </div>
                  </div>

                  {filtered.length === 0 ? (
                    <div className="px-3 py-4 text-[11px] text-[var(--text-dim)]">No models match these filters.</div>
                  ) : (
                    <div className="max-h-[50vh] overflow-y-auto">
                      <ModelTable
                        models={filtered.slice(0, 200)}
                        draft={draft}
                        savedIds={{
                          main: current.main.id,
                          fast: current.fast.id,
                        }}
                        activeSlot={activeSlot}
                        sort={sort}
                        sortDir={sortDir}
                        onSort={setSortKey}
                        onPick={pickModel}
                      />
                      {filtered.length > 200 ? (
                        <div className="px-3 py-2 text-center text-[10px] text-[var(--text-faint)]">
                          Showing first 200 — refine your search to see more.
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          onClick={onSave}
          disabled={!dirty || saving}
          variant={dirty ? "success" : "successOutline"}
          size="md"
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </Button>
        {dirty ? (
          <Button onClick={resetToCurrent} variant="subtle" size="md" disabled={saving}>
            Undo
          </Button>
        ) : null}
        <Button
          onClick={resetToDefaults}
          variant="subtle"
          size="md"
          disabled={saving || atDefaults || !current.defaults}
          title={atDefaults ? "Already at defaults" : "Reset all roles to the built-in defaults"}
        >
          Reset to defaults
        </Button>
        {status ? (
          <span
            className={`ml-1 text-[11px] ${status.tone === "success" ? "text-emerald-300" : "text-rose-300"}`}
          >
            {status.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RecRow({
  model,
  selected,
  currentlySaved,
  onPick,
  first,
  last,
}: {
  model: OpenRouterModelInfo;
  selected: boolean;
  currentlySaved: boolean;
  onPick: () => void;
  first: boolean;
  last: boolean;
}) {
  const reason = reasonFor(model);
  return (
    <button
      onClick={onPick}
      title={reason}
      className={`group flex items-center gap-3 border-x border-b border-[#1f1f23] bg-[#111113] px-3 py-1.5 text-left transition-colors hover:bg-[#141416] ${
        first ? "rounded-t-lg border-t" : ""
      } ${last ? "rounded-b-lg" : ""} ${
        selected ? "border-emerald-400/60 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.09]" : ""
      }`}
    >
      <span
        className={`shrink-0 truncate font-mono text-[11px] ${selected ? "text-emerald-100" : "text-[#ededed]"}`}
        style={{ maxWidth: "40ch" }}
      >
        {model.id}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {isNitro(model.id) ? <Tag color="amber">nitro</Tag> : null}
        {model.supportsTools ? <Tag color="blue">tools</Tag> : null}
        {model.supportsReasoning ? <Tag color="purple">reasoning</Tag> : null}
      </div>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--text-dim)]">
        <span className={selected ? "text-emerald-200" : "text-[#ededed]"}>
          {fmtPrice(model.promptPriceUsdPerM)}
        </span>
        <span className="text-[var(--text-faint)]"> / </span>
        <span className={selected ? "text-emerald-200" : "text-[#ededed]"}>
          {fmtPrice(model.completionPriceUsdPerM)}
        </span>
        <span className="ml-1.5 text-[var(--text-faint)]">· {fmtContext(model.contextLength)}</span>
      </span>
      <span className="w-14 shrink-0 text-right">
        {selected ? (
          <span className="text-[10px] font-medium text-emerald-300">✓ picked</span>
        ) : currentlySaved ? (
          <span className="text-[9px] uppercase text-[var(--text-dim)]">saved</span>
        ) : (
          <span className="text-[10px] text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100">
            pick
          </span>
        )}
      </span>
    </button>
  );
}

function ModelTable({
  models,
  draft,
  savedIds,
  activeSlot,
  sort,
  sortDir,
  onSort,
  onPick,
}: {
  models: OpenRouterModelInfo[];
  draft: Record<ModelSlot, string>;
  savedIds: Record<ModelSlot, string>;
  activeSlot: ModelSlot;
  sort: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  onPick: (id: string) => void;
}) {
  const draftUsedBy = useMemo(() => {
    const map = new Map<string, ModelSlot[]>();
    for (const s of SLOT_ORDER) {
      const arr = map.get(draft[s]) ?? [];
      arr.push(s);
      map.set(draft[s], arr);
    }
    return map;
  }, [draft]);

  return (
    <table className="w-full text-[11px]">
      <thead className="sticky top-0 z-10 bg-[#0d0d0f] text-[9px] uppercase tracking-wider text-[var(--text-faint)]">
        <tr className="border-b border-[#1f1f23]">
          <SortableHeader label="Model" col="name" sort={sort} sortDir={sortDir} onSort={onSort} align="left" />
          <SortableHeader label="$ in / M" col="prompt" sort={sort} sortDir={sortDir} onSort={onSort} align="right" />
          <SortableHeader
            label="$ out / M"
            col="completion"
            sort={sort}
            sortDir={sortDir}
            onSort={onSort}
            align="right"
          />
          <SortableHeader label="Context" col="context" sort={sort} sortDir={sortDir} onSort={onSort} align="right" />
          <SortableHeader label="Listed" col="listed" sort={sort} sortDir={sortDir} onSort={onSort} align="right" />
          <SortableHeader
            label="Created"
            col="recency"
            sort={sort}
            sortDir={sortDir}
            onSort={onSort}
            align="right"
          />
          <th className="px-3 py-1.5 text-right font-medium w-[90px]" />
        </tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const assignedSlots = draftUsedBy.get(m.id) ?? [];
          const isActive = assignedSlots.includes(activeSlot);
          const isSavedForActive = savedIds[activeSlot] === m.id;
          return (
            <tr
              key={m.id}
              onClick={() => onPick(m.id)}
              className={`cursor-pointer border-b border-[#141416] transition-colors ${
                isActive ? "bg-emerald-500/[0.06] hover:bg-emerald-500/[0.09]" : "hover:bg-[#141416]"
              }`}
            >
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`truncate font-mono ${isActive ? "text-emerald-200" : "text-[#ededed]"}`}
                    title={m.id}
                  >
                    {m.id}
                  </span>
                  {isNitro(m.id) ? <Tag color="amber">nitro</Tag> : null}
                  {m.supportsTools ? <Tag color="blue">tools</Tag> : null}
                  {m.supportsReasoning ? <Tag color="purple">reasoning</Tag> : null}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-[var(--text-dim)]">{m.name}</div>
              </td>
              <td
                className={`px-3 py-1.5 text-right font-mono text-[11px] ${isActive ? "text-emerald-200" : "text-[#ededed]"}`}
              >
                {fmtPrice(m.promptPriceUsdPerM)}
              </td>
              <td
                className={`px-3 py-1.5 text-right font-mono text-[11px] ${isActive ? "text-emerald-200" : "text-[#ededed]"}`}
              >
                {fmtPrice(m.completionPriceUsdPerM)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-[10px] text-[var(--text-dim)]">
                {fmtContext(m.contextLength)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-[10px] text-[var(--text-dim)]">#{m.catalogOrder + 1}</td>
              <td className="px-3 py-1.5 text-right font-mono text-[10px] text-[var(--text-dim)]">
                {m.createdAt ? new Date(m.createdAt * 1000).toISOString().slice(0, 7) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right">
                <div className="flex items-center justify-end gap-1">
                  {isSavedForActive && !isActive ? (
                    <span className="rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-[1px] text-[9px] uppercase text-[var(--text-dim)]">
                      saved
                    </span>
                  ) : null}
                  {assignedSlots.length > 0 ? (
                    <span
                      className={`rounded-full px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider ${
                        isActive
                          ? "border border-emerald-500/35 bg-emerald-500/[0.12] text-emerald-200"
                          : "border border-[#2a2a2e] bg-[#1a1a1d] text-[var(--text-dim)]"
                      }`}
                      title={`Assigned to: ${assignedSlots.map((s) => SLOT_META[s].label).join(", ")}`}
                    >
                      {assignedSlots.map((s) => SLOT_META[s].label[0]).join("·")}
                      {isActive ? " ✓" : ""}
                    </span>
                  ) : null}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SortableHeader({
  label,
  col,
  sort,
  sortDir,
  onSort,
  align,
}: {
  label: string;
  col: SortKey;
  sort: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align: "left" | "right";
}) {
  const active = sort === col;
  return (
    <th className={`px-3 py-1.5 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 font-medium uppercase tracking-wider transition-colors hover:text-[#ededed] ${
          active ? "text-[#ededed]" : "text-[var(--text-faint)]"
        }`}
      >
        {label}
        {active ? (
          <span className="text-[9px]">{sortDir === "asc" ? "↑" : "↓"}</span>
        ) : null}
      </button>
    </th>
  );
}

function Tag({
  color,
  children,
}: {
  color: "blue" | "purple" | "amber";
  children: React.ReactNode;
}) {
  const map = {
    blue: "border-blue-500/20 bg-blue-500/[0.08] text-blue-300",
    purple: "border-purple-500/20 bg-purple-500/[0.08] text-purple-300",
    amber: "border-amber-500/25 bg-amber-500/[0.08] text-amber-300",
  };
  return (
    <span
      className={`rounded-full border px-1 py-[1px] text-[8px] font-medium uppercase ${map[color]}`}
    >
      {children}
    </span>
  );
}

function FilterToggle({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300"
          : "border-[#1f1f23] bg-[#0d0d0f] text-[#666] hover:border-[#2a2a2e] hover:text-[#9a9aa3]"
      }`}
    >
      {label}
    </button>
  );
}
