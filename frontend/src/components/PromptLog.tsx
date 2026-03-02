import { useEffect, useRef, useState } from "react";
import type {
  BatchDecision,
  GepaLogEntry,
  GepaResult,
  RunStatus,
} from "../lib/types";

const ROLE_STYLES: Record<string, string> = {
  system: "bg-slate-700 text-slate-200",
  user: "bg-blue-700 text-blue-100",
  assistant: "bg-green-700 text-green-100",
};

function gepaScoreColor(score: number): string {
  if (score >= 0.8) return "bg-green-100 text-green-800";
  if (score > 0.4) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-800";
}

interface Props {
  batches: BatchDecision[];
  status: RunStatus;
  selectedBatchId: string | null;
  gepaLog: GepaLogEntry[];
  gepaResult: GepaResult | null;
}

export default function PromptLog({
  batches,
  status,
  selectedBatchId,
  gepaLog,
  gepaResult,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const userScrolledRef = useRef(false);
  const [expandedGepaIter, setExpandedGepaIter] = useState<Set<number>>(
    new Set(),
  );

  // Auto-scroll to bottom when new batches arrive during traversal
  useEffect(() => {
    if (status !== "traversing" || userScrolledRef.current) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [batches.length, status]);

  // Auto-scroll when gepa log updates
  useEffect(() => {
    if (gepaLog.length === 0) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [gepaLog.length]);

  // When a batch is clicked, scroll to its entry
  useEffect(() => {
    if (!selectedBatchId) return;
    const el = entryRefs.current.get(selectedBatchId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      userScrolledRef.current = true;
    }
  }, [selectedBatchId]);

  // Reset user-scrolled flag when a new traversal starts
  useEffect(() => {
    if (status === "traversing") {
      userScrolledRef.current = false;
    }
  }, [status]);

  const handleScroll = () => {
    if (status !== "traversing") return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    userScrolledRef.current = !atBottom;
  };

  const toggleGepaIter = (iter: number) => {
    setExpandedGepaIter((prev) => {
      const next = new Set(prev);
      if (next.has(iter)) {
        next.delete(iter);
      } else {
        next.add(iter);
      }
      return next;
    });
  };

  const hasEntries = batches.length > 0;
  const hasGepa = gepaLog.length > 0;

  // Group GEPA log entries by iteration
  const gepaByIter = new Map<number, GepaLogEntry[]>();
  for (const entry of gepaLog) {
    const list = gepaByIter.get(entry.iteration) ?? [];
    list.push(entry);
    gepaByIter.set(entry.iteration, list);
  }

  return (
    <div className="flex h-full flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Prompt Log
        </h2>
        {status === "traversing" && (
          <span className="flex items-center gap-1 text-[10px] text-blue-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            live
          </span>
        )}
        {hasEntries && (
          <span className="text-[10px] text-slate-400">
            {batches.length} {batches.length === 1 ? "batch" : "batches"}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {!hasEntries && !hasGepa ? (
          <p className="px-3 py-8 text-center text-xs text-slate-400">
            {status === "traversing"
              ? "Waiting for first batch..."
              : "Prompts will appear here during traversal."}
          </p>
        ) : (
          <>
            {/* Batch entries */}
            {hasEntries && (
              <div className="divide-y divide-slate-100">
                {batches.map((batch) => {
                  const isSelected = selectedBatchId === batch.batchId;
                  return (
                    <div
                      key={batch.batchId}
                      ref={(el) => {
                        if (el) {
                          entryRefs.current.set(batch.batchId, el);
                        } else {
                          entryRefs.current.delete(batch.batchId);
                        }
                      }}
                      className={`px-3 py-2 ${isSelected ? "bg-blue-50" : ""}`}
                    >
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-semibold text-slate-700">
                          {batch.batchId}
                        </span>
                        {batch.selectedIds.length > 0 && (
                          <span className="text-[10px] text-green-600">
                            {batch.selectedIds.length} selected
                          </span>
                        )}
                      </div>

                      {batch.promptMessages.length > 0 ? (
                        <div className="space-y-1.5">
                          {batch.promptMessages.map((msg, i) => (
                            <div key={i}>
                              <span
                                className={`inline-block rounded px-1 py-0.5 text-[9px] font-semibold uppercase leading-none ${
                                  ROLE_STYLES[msg.role] ??
                                  "bg-slate-500 text-white"
                                }`}
                              >
                                {msg.role}
                              </span>
                              <pre className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-slate-100 bg-slate-50 p-1.5 font-mono text-[10px] leading-tight text-slate-600">
                                {msg.content}
                              </pre>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[10px] italic text-slate-400">
                          No prompt (skipped or pre-populated)
                        </p>
                      )}

                      {batch.selectedIds.length > 0 && (
                        <div className="mt-1.5 rounded border border-green-100 bg-green-50 px-1.5 py-1">
                          <span className="text-[9px] font-semibold uppercase text-green-700">
                            Selected
                          </span>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {batch.selectedIds.map((code) => (
                              <span
                                key={code}
                                className="rounded bg-green-100 px-1 py-0.5 font-mono text-[10px] font-medium text-green-800"
                              >
                                {code}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {batch.reasoning && (
                        <p className="mt-1 text-[10px] leading-tight text-slate-500 line-clamp-3">
                          {batch.reasoning}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* GEPA Optimization section */}
            {hasGepa && (
              <div className="border-t-2 border-purple-200">
                <div className="flex items-center gap-1.5 bg-purple-50 px-3 py-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-purple-700">
                    GEPA Optimization
                  </span>
                  {!gepaResult && (
                    <span className="flex items-center gap-1 text-[10px] text-purple-500">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500" />
                      running
                    </span>
                  )}
                </div>

                <div className="divide-y divide-purple-100">
                  {[...gepaByIter.entries()].map(([iter, entries]) => {
                    const mutation = entries.find(
                      (e) => e.type === "mutation",
                    );
                    const accepted = entries.some(
                      (e) => e.type === "accepted",
                    );
                    const rejected = entries.some(
                      (e) => e.type === "rejected",
                    );
                    const iterStart = entries.find(
                      (e) => e.type === "iteration_start",
                    );
                    const isExpanded = expandedGepaIter.has(iter);

                    return (
                      <div key={iter} className="px-3 py-2">
                        <button
                          onClick={() => toggleGepaIter(iter)}
                          className="flex w-full items-center gap-2 text-left"
                        >
                          <span className="text-[10px] text-slate-400">
                            {isExpanded ? "\u25BC" : "\u25B6"}
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-purple-700">
                            Iteration {iter}
                          </span>
                          {iterStart?.score != null && (
                            <span
                              className={`rounded px-1 py-0.5 font-mono text-[10px] font-bold ${gepaScoreColor(iterStart.score)}`}
                            >
                              {iterStart.score.toFixed(2)}
                            </span>
                          )}
                          {accepted && (
                            <span className="rounded bg-green-100 px-1 py-0.5 text-[9px] font-bold text-green-700">
                              Accepted
                            </span>
                          )}
                          {rejected && (
                            <span className="rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-700">
                              Rejected
                            </span>
                          )}
                        </button>

                        {isExpanded && (
                          <div className="mt-2 space-y-1.5">
                            {/* Mutation: show old → new instruction */}
                            {mutation?.newText && (
                              <div>
                                <span className="text-[9px] font-semibold uppercase text-purple-600">
                                  {mutation.component ?? "instruction_template"}
                                </span>
                                <pre className="mt-0.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded border border-purple-200 bg-purple-50 p-1.5 font-mono text-[10px] leading-tight text-purple-900">
                                  {mutation.newText}
                                </pre>
                              </div>
                            )}

                            {/* Log messages */}
                            {entries.map((entry, i) => (
                              <p
                                key={i}
                                className="text-[10px] leading-tight text-slate-500"
                              >
                                {entry.message}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Best result summary */}
                {gepaResult && (
                  <div className="border-t border-purple-200 bg-purple-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-purple-700">
                        Best Score:
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ${gepaScoreColor(gepaResult.bestScore)}`}
                      >
                        {gepaResult.bestScore.toFixed(2)}
                      </span>
                      <span className="text-[10px] text-green-600 font-semibold">
                        Best Prompt Applied
                      </span>
                    </div>
                    {gepaResult.bestCandidate["instruction_template"] && (
                      <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-green-200 bg-green-50 p-1.5 font-mono text-[10px] leading-tight text-green-900">
                        {gepaResult.bestCandidate["instruction_template"]}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
