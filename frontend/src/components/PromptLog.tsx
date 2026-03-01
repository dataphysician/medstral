import { useEffect, useRef } from "react";
import type { BatchDecision, RunStatus } from "../lib/types";

const ROLE_STYLES: Record<string, string> = {
  system: "bg-slate-700 text-slate-200",
  user: "bg-blue-700 text-blue-100",
  assistant: "bg-green-700 text-green-100",
};

interface Props {
  batches: BatchDecision[];
  status: RunStatus;
  selectedBatchId: string | null;
}

export default function PromptLog({ batches, status, selectedBatchId }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const userScrolledRef = useRef(false);

  // Auto-scroll to bottom when new batches arrive during traversal
  useEffect(() => {
    if (status !== "traversing" || userScrolledRef.current) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [batches.length, status]);

  // When a batch is clicked, scroll to its entry
  useEffect(() => {
    if (!selectedBatchId) return;
    const el = entryRefs.current.get(selectedBatchId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Reset user-scrolled flag so auto-scroll resumes if de-selected
      userScrolledRef.current = true;
    }
  }, [selectedBatchId]);

  // Reset user-scrolled flag when a new traversal starts
  useEffect(() => {
    if (status === "traversing") {
      userScrolledRef.current = false;
    }
  }, [status]);

  // Detect user scroll to pause auto-scroll
  const handleScroll = () => {
    if (status !== "traversing") return;
    const el = scrollRef.current;
    if (!el) return;
    // If user is near the bottom, keep auto-scrolling
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    userScrolledRef.current = !atBottom;
  };

  const hasEntries = batches.length > 0;

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
        {!hasEntries ? (
          <p className="px-3 py-8 text-center text-xs text-slate-400">
            {status === "traversing"
              ? "Waiting for first batch..."
              : "Prompts will appear here during traversal."}
          </p>
        ) : (
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
                  {/* Batch header */}
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

                  {/* Prompt messages */}
                  {batch.promptMessages.length > 0 ? (
                    <div className="space-y-1.5">
                      {batch.promptMessages.map((msg, i) => (
                        <div key={i}>
                          <span
                            className={`inline-block rounded px-1 py-0.5 text-[9px] font-semibold uppercase leading-none ${
                              ROLE_STYLES[msg.role] ?? "bg-slate-500 text-white"
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

                  {/* Selection result */}
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

                  {/* Reasoning excerpt */}
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
      </div>
    </div>
  );
}
