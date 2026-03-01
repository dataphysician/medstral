import { useMemo } from "react";
import { buildCodePath } from "../lib/parse";
import type { BatchDecision } from "../lib/types";

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
  onToggleBatch: (batchId: string) => void;
  onBack: () => void;
}

export default function CodeTraversal({
  code,
  batches,
  onToggleBatch,
  onBack,
}: Props) {
  const path = useMemo(() => buildCodePath(code, batches), [code, batches]);

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
                      {/* Batch label */}
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-semibold text-slate-700 truncate">
                          {batch.batchId}
                        </span>
                        <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium text-slate-500 bg-slate-100">
                          {typeLabel}
                        </span>
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
      </div>
    </div>
  );
}
