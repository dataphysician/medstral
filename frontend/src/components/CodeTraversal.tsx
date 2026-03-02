import { useCallback, useMemo, useRef, useState } from "react";
import { fetchGoldTrajectory, streamGepaOptimize, streamOptimize } from "../lib/api";
import type { StreamHandle } from "../lib/agent";
import { buildCodePath, computeDivergence, extractFullState, isFullStateSnapshot } from "../lib/parse";
import type {
  AGUIEvent,
  BatchDecision,
  DivergenceResult,
  GepaLogEntry,
  GepaResult,
  LLMSettings,
} from "../lib/types";

/** Edge color per batch relationship type. */
const EDGE_COLORS: Record<string, string> = {
  children: "border-blue-400",
  codeFirst: "border-amber-400",
  codeAlso: "border-purple-400",
  useAdditionalCode: "border-teal-400",
  sevenChrDef: "border-rose-400",
};

const EDGE_BG: Record<string, string> = {
  children: "bg-blue-400",
  codeFirst: "bg-amber-400",
  codeAlso: "bg-purple-400",
  useAdditionalCode: "bg-teal-400",
  sevenChrDef: "bg-rose-400",
};

const TYPE_LABELS: Record<string, string> = {
  children: "Children",
  codeFirst: "Code First",
  codeAlso: "Code Also",
  useAdditionalCode: "Additional",
  sevenChrDef: "7th Char",
};

interface Props {
  code: string;
  batches: BatchDecision[];
  clinicalNote: string;
  settings: LLMSettings;
  onToggleBatch: (batchId: string) => void;
  onBack: () => void;
  onOptimizeComplete: (batches: BatchDecision[], finalCodes: string[]) => void;
  onGepaLog: (log: GepaLogEntry[], result: GepaResult | null) => void;
}

function scoreColor(score: number): string {
  if (score >= 0.8) return "bg-green-100 text-green-800";
  if (score > 0.4) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

export default function CodeTraversal({
  code,
  batches,
  clinicalNote,
  settings,
  onToggleBatch,
  onBack,
  onOptimizeComplete,
  onGepaLog,
}: Props) {
  const path = useMemo(() => buildCodePath(code, batches), [code, batches]);

  // Evaluate & Optimize state
  const [goldCode, setGoldCode] = useState("");
  const [divergence, setDivergence] = useState<DivergenceResult | null>(null);
  const [feedback, setFeedback] = useState("");
  const [isComputing, setIsComputing] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizeBatchCount, setOptimizeBatchCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const optimizeHandleRef = useRef<StreamHandle | null>(null);

  // GEPA state
  const [numIters, setNumIters] = useState(3);
  const [isGepaRunning, setIsGepaRunning] = useState(false);
  const gepaHandleRef = useRef<StreamHandle | null>(null);

  // Build a lookup for quick match checking
  const matchByBatchId = useMemo(() => {
    if (!divergence) return null;
    const map = new Map<string, boolean>();
    for (const entry of divergence.path) {
      map.set(entry.batchId, entry.match);
    }
    return map;
  }, [divergence]);

  const handleComputeDivergence = useCallback(async () => {
    if (!goldCode.trim()) return;
    setError(null);
    setDivergence(null);
    setIsComputing(true);
    try {
      const goldTraj = await fetchGoldTrajectory(goldCode.trim());
      const result = computeDivergence(path, goldTraj, code);
      setDivergence(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsComputing(false);
    }
  }, [goldCode, path, code]);

  const handleOptimize = useCallback(() => {
    if (!divergence || divergence.divergenceBatchId === null) return;
    setIsOptimizing(true);
    setOptimizeBatchCount(0);
    setError(null);

    const combinedFeedback = [divergence.feedback, feedback.trim()]
      .filter(Boolean)
      .join("\n");

    const handleEvent = (event: AGUIEvent) => {
      switch (event.type) {
        case "STEP_STARTED":
          setOptimizeBatchCount((c) => c + 1);
          break;
        case "STATE_SNAPSHOT": {
          const snapshot = event.snapshot;
          if (isFullStateSnapshot(snapshot)) {
            const { finalCodes, allBatches } = extractFullState(snapshot);
            if (allBatches.length > 0) {
              onOptimizeComplete(allBatches, finalCodes);
            }
          }
          break;
        }
        case "RUN_FINISHED":
          setIsOptimizing(false);
          break;
        case "RUN_ERROR":
          setIsOptimizing(false);
          setError(event.message);
          break;
      }
    };

    const handleError = (err: Error) => {
      setIsOptimizing(false);
      setError(err.message);
    };

    const handleDone = () => {
      setIsOptimizing(false);
      optimizeHandleRef.current = null;
    };

    optimizeHandleRef.current = streamOptimize(
      {
        batchId: divergence.divergenceBatchId,
        clinicalNote,
        goldCode: divergence.goldCode,
        feedback: combinedFeedback,
      },
      settings,
      handleEvent,
      handleError,
      handleDone,
    );
  }, [divergence, feedback, clinicalNote, settings, onOptimizeComplete]);

  const handleGepaOptimize = useCallback(() => {
    if (!goldCode.trim()) return;
    setIsGepaRunning(true);
    setError(null);

    const goldCodes = goldCode
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const logEntries: GepaLogEntry[] = [];

    const handleEvent = (event: AGUIEvent) => {
      switch (event.type) {
        case "CUSTOM": {
          const val = event.value;
          if (typeof val !== "object" || val === null || Array.isArray(val))
            break;
          const rec = val as Record<string, unknown>;

          if (event.name === "gepa_log" || event.name === "gepa_mutation" || event.name === "gepa_accepted" || event.name === "gepa_rejected") {
            const entry: GepaLogEntry = {
              type: (typeof rec["type"] === "string" ? rec["type"] : "log") as GepaLogEntry["type"],
              iteration: typeof rec["iteration"] === "number" ? rec["iteration"] : 0,
              message: typeof rec["message"] === "string" ? rec["message"] : "",
              timestamp: typeof rec["timestamp"] === "number" ? rec["timestamp"] : Date.now(),
              component: typeof rec["component"] === "string" ? rec["component"] : undefined,
              oldText: typeof rec["old_text"] === "string" ? rec["old_text"] : undefined,
              newText: typeof rec["new_text"] === "string" ? rec["new_text"] : undefined,
              score: typeof rec["score"] === "number" ? rec["score"] : undefined,
            };
            logEntries.push(entry);
            onGepaLog([...logEntries], null);
          }

          if (event.name === "gepa_result") {
            const bestCandidate =
              typeof rec["best_candidate"] === "object" &&
              rec["best_candidate"] !== null &&
              !Array.isArray(rec["best_candidate"])
                ? (rec["best_candidate"] as Record<string, string>)
                : {};
            const bestScore =
              typeof rec["best_score"] === "number" ? rec["best_score"] : 0;
            const rawCandidates = Array.isArray(rec["candidates"])
              ? rec["candidates"]
              : [];
            const candidates = rawCandidates
              .filter(
                (c): c is Record<string, unknown> =>
                  typeof c === "object" && c !== null,
              )
              .map((c) => ({
                candidate:
                  typeof c["candidate"] === "object" &&
                  c["candidate"] !== null &&
                  !Array.isArray(c["candidate"])
                    ? (c["candidate"] as Record<string, string>)
                    : {},
                score: typeof c["score"] === "number" ? c["score"] : 0,
              }));
            const totalIterations =
              typeof rec["total_iterations"] === "number"
                ? rec["total_iterations"]
                : 0;

            const result: GepaResult = {
              bestCandidate,
              bestScore,
              candidates,
              totalIterations,
            };

            onGepaLog(logEntries, result);
          }
          break;
        }
        case "STATE_SNAPSHOT": {
          const snapshot = event.snapshot;
          if (isFullStateSnapshot(snapshot)) {
            const { finalCodes, allBatches } = extractFullState(snapshot);
            if (allBatches.length > 0) {
              // Update with the final re-traversal results from GEPA
              onOptimizeComplete(allBatches, finalCodes);
            }
          }
          break;
        }
        case "RUN_FINISHED":
          setIsGepaRunning(false);
          break;
        case "RUN_ERROR":
          setIsGepaRunning(false);
          setError(event.message);
          break;
      }
    };

    const handleError = (err: Error) => {
      setIsGepaRunning(false);
      setError(err.message);
    };

    const handleDone = () => {
      setIsGepaRunning(false);
      gepaHandleRef.current = null;
    };

    gepaHandleRef.current = streamGepaOptimize(
      {
        clinicalNote,
        goldCodes,
        numIters,
      },
      settings,
      handleEvent,
      handleError,
      handleDone,
    );
  }, [
    goldCode,
    clinicalNote,
    numIters,
    settings,
    onGepaLog,
    onOptimizeComplete,
  ]);

  return (
    <div className="flex h-full flex-col border-r border-slate-200 bg-white">
      {/* Header */}
      <div className="border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Back to Prompt Log"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Code Traversal
            </h2>
            <span className="font-mono text-sm font-bold text-green-700">
              {code}
            </span>
          </div>
        </div>
      </div>

      {/* Vertical trace */}
      <div className="flex-1 overflow-y-auto p-3">
        {path.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">
            No traversal path found for this code.
          </p>
        ) : (
          <div className="space-y-0">
            {path.map((batch, i) => {
              const edgeColor =
                EDGE_COLORS[batch.batchType] ?? "border-slate-300";
              const dotColor = EDGE_BG[batch.batchType] ?? "bg-slate-300";
              const typeLabel =
                TYPE_LABELS[batch.batchType] ?? batch.batchType;
              const isLast = i === path.length - 1;

              // Divergence annotation
              const matchStatus = matchByBatchId?.get(batch.batchId);
              const showMatch = matchStatus !== undefined;

              return (
                <div key={batch.batchId} className="relative">
                  {/* Connecting edge to next tier */}
                  {!isLast && (
                    <div
                      className={`absolute left-[7px] top-8 bottom-0 w-0 border-l-2 ${edgeColor}`}
                    />
                  )}

                  {/* Tier button */}
                  <button
                    onClick={() => onToggleBatch(batch.batchId)}
                    className="group relative flex w-full items-start gap-2 rounded px-0 py-1.5 text-left hover:bg-slate-50"
                    title={`Toggle ${batch.batchId} in chat`}
                  >
                    {/* Dot */}
                    <span
                      className={`mt-1 h-4 w-4 shrink-0 rounded-full ${dotColor}`}
                    />

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      {/* Batch label + match indicator */}
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-semibold text-slate-700 truncate">
                          {batch.batchId}
                        </span>
                        <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium text-slate-500 bg-slate-100">
                          {typeLabel}
                        </span>
                        {showMatch && (
                          <span
                            className={`shrink-0 text-[11px] font-bold ${
                              matchStatus
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                            title={
                              matchStatus
                                ? "Matches gold trajectory"
                                : "Diverges from gold trajectory"
                            }
                          >
                            {matchStatus ? "\u2713" : "\u2717"}
                          </span>
                        )}
                      </div>

                      {/* Selected IDs */}
                      {batch.selectedIds.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {batch.selectedIds.map((id) => (
                            <span
                              key={id}
                              className={`rounded px-1 py-0.5 font-mono text-[10px] ${
                                id === code ||
                                path.some((p) => p.nodeId === id)
                                  ? "bg-green-100 font-semibold text-green-800"
                                  : "bg-slate-100 text-slate-500"
                              }`}
                            >
                              {id}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Reasoning */}
                      {batch.reasoning && (
                        <p className="mt-1 text-[10px] leading-tight text-slate-500 line-clamp-2">
                          {batch.reasoning}
                        </p>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}

            {/* Final code indicator */}
            <div className="relative flex items-center gap-2 py-1.5">
              <span className="h-4 w-4 shrink-0 rounded-full bg-green-500 ring-2 ring-green-200" />
              <span className="font-mono text-xs font-bold text-green-700">
                {code}
              </span>
            </div>
          </div>
        )}

        {/* ─── Evaluate & Optimize ─── */}
        <div className="mt-4 border-t border-slate-200 pt-3">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Evaluate &amp; Optimize
          </h3>

          {/* Gold code input */}
          <div className="flex gap-1.5">
            <input
              type="text"
              value={goldCode}
              onChange={(e) => {
                setGoldCode(e.target.value);
                setDivergence(null);
                setError(null);
              }}
              placeholder="Expected code (e.g. E11.641)"
              className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 font-mono text-[11px] text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
              disabled={isOptimizing}
            />
            <button
              onClick={handleComputeDivergence}
              disabled={!goldCode.trim() || isComputing || isOptimizing}
              className="shrink-0 rounded bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isComputing ? "Computing..." : "Compute"}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] text-red-700">
              {error}
            </div>
          )}

          {/* Divergence results */}
          {divergence && (
            <div className="mt-3 space-y-2">
              {/* Score + metrics row */}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ${scoreColor(divergence.score)}`}
                >
                  {divergence.score.toFixed(2)}
                </span>
                {divergence.divergenceDepth !== null ? (
                  <span className="text-[10px] text-slate-600">
                    Divergence at{" "}
                    <span className="font-semibold">
                      depth {divergence.divergenceDepth}
                    </span>
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold text-green-600">
                    Exact match
                  </span>
                )}
                <span className="text-[10px] text-slate-400">
                  LCP: <span className="font-mono">{divergence.lcp || "\u2014"}</span>
                </span>
              </div>

              {/* Gold vs pred codes */}
              <div className="flex gap-3 text-[10px]">
                <span className="text-slate-500">
                  Predicted:{" "}
                  <span className="font-mono font-semibold text-slate-700">
                    {divergence.predCode}
                  </span>
                </span>
                <span className="text-slate-500">
                  Expected:{" "}
                  <span className="font-mono font-semibold text-green-700">
                    {divergence.goldCode}
                  </span>
                </span>
              </div>

              {/* Auto-generated feedback */}
              <p className="text-[10px] leading-tight text-slate-600 italic">
                {divergence.feedback}
              </p>

              {/* User feedback textarea */}
              {divergence.divergenceDepth !== null && (
                <>
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Describe what went wrong (optional)..."
                    rows={2}
                    disabled={isOptimizing}
                    className="w-full rounded border border-slate-200 px-2 py-1.5 text-[10px] text-slate-700 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:opacity-50"
                  />

                  {/* Optimize button */}
                  <button
                    onClick={handleOptimize}
                    disabled={isOptimizing || isGepaRunning}
                    className="w-full rounded bg-amber-600 px-2 py-1.5 text-[10px] font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isOptimizing ? (
                      <span className="flex items-center justify-center gap-1.5">
                        <svg
                          className="h-3 w-3 animate-spin"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <circle
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                            className="opacity-25"
                          />
                          <path
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                            fill="currentColor"
                            className="opacity-75"
                          />
                        </svg>
                        Optimizing... {optimizeBatchCount > 0 ? `(${optimizeBatchCount} batches)` : ""}
                      </span>
                    ) : (
                      `Optimize selector_d${divergence.divergenceDepth}`
                    )}
                  </button>
                </>
              )}

              {/* GEPA Optimize section — always show when gold code exists */}
              <div className="mt-3 border-t border-purple-200 pt-3">
                <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                  GEPA Evolutionary Optimize
                </h4>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-slate-500">Iters:</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={numIters}
                    onChange={(e) =>
                      setNumIters(
                        Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                      )
                    }
                    disabled={isGepaRunning || isOptimizing}
                    className="w-14 rounded border border-slate-200 px-1.5 py-0.5 text-center font-mono text-[10px] text-slate-700 focus:border-purple-400 focus:outline-none disabled:opacity-50"
                  />
                  <button
                    onClick={handleGepaOptimize}
                    disabled={isGepaRunning || isOptimizing}
                    className="flex-1 rounded bg-purple-600 px-2 py-1.5 text-[10px] font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isGepaRunning ? (
                      <span className="flex items-center justify-center gap-1.5">
                        <svg
                          className="h-3 w-3 animate-spin"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <circle
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                            className="opacity-25"
                          />
                          <path
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                            fill="currentColor"
                            className="opacity-75"
                          />
                        </svg>
                        GEPA running...
                      </span>
                    ) : (
                      `GEPA Optimize (${numIters} iters)`
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
