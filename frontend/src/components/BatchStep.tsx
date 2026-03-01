import type { BatchDecision } from "../lib/types";

const BATCH_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  children: { label: "Children", color: "bg-blue-100 text-blue-700" },
  codeFirst: { label: "Code First", color: "bg-amber-100 text-amber-700" },
  codeAlso: { label: "Code Also", color: "bg-purple-100 text-purple-700" },
  useAdditionalCode: {
    label: "Additional",
    color: "bg-teal-100 text-teal-700",
  },
  sevenChrDef: { label: "7th Char", color: "bg-rose-100 text-rose-700" },
};

const DEPTH_LABELS: Record<number, string> = {
  0: "ROOT",
  1: "Chapter",
  2: "Block",
  3: "Category",
  4: "Subcategory",
  5: "Classification",
  6: "Subclass.",
  7: "7th Char",
};

interface Props {
  batch: BatchDecision;
  expanded: boolean;
  selected?: boolean;
  onToggle: (batchId: string) => void;
  onSelect?: (batch: BatchDecision) => void;
}

export default function BatchStep({
  batch,
  expanded,
  selected,
  onToggle,
  onSelect,
}: Props) {
  const meta = BATCH_TYPE_LABELS[batch.batchType] ?? {
    label: batch.batchType,
    color: "bg-slate-100 text-slate-700",
  };

  const candidateCount = Object.keys(batch.candidates).length;
  const selectedCount = batch.selectedIds.length;

  // Indent level: ROOT (depth 0) = 0, Chapter (depth 1) = 1, Block (depth 2) = 2, ...
  const indent = Math.max(0, batch.depth);
  const depthLabel = DEPTH_LABELS[batch.depth] ?? `D${batch.depth}`;

  return (
    <div style={{ paddingLeft: `${indent * 16}px` }}>
      <div className="border-l-2 border-slate-200 pl-2">
        {/* Header row — always visible */}
        <button
          onClick={() => {
            onToggle(batch.batchId);
            onSelect?.(batch);
          }}
          className={`flex w-full items-center gap-1.5 text-left text-sm rounded px-1 py-0.5 ${
            selected
              ? "bg-blue-50 ring-1 ring-blue-300"
              : "hover:bg-slate-50"
          }`}
        >
          <span className="text-slate-400 text-xs select-none">
            {expanded ? "\u25BE" : "\u25B8"}
          </span>
          <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-400 min-w-[4rem] text-center">
            {depthLabel}
          </span>
          <span className="font-mono text-xs text-slate-600 font-semibold">
            {batch.nodeId}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.color}`}
          >
            {meta.label}
          </span>
          <span className="text-xs text-slate-400">
            {selectedCount}/{candidateCount}
          </span>
          {selectedCount > 0 && (
            <span className="font-mono text-xs text-slate-700 truncate">
              {batch.selectedIds.join(", ")}
            </span>
          )}
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-1 ml-6 space-y-2 text-xs pb-1">
            {/* Candidates */}
            {candidateCount > 0 && (
              <div>
                <span className="font-medium text-slate-500">Candidates:</span>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {Object.entries(batch.candidates).map(([code, label]) => {
                    const isSelected = batch.selectedIds.includes(code);
                    return (
                      <span
                        key={code}
                        className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono ${
                          isSelected
                            ? "bg-green-100 text-green-800 font-semibold"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {code}
                        <span
                          className="ml-1 max-w-[18ch] truncate font-sans text-slate-400"
                          title={label}
                        >
                          {label}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Reasoning */}
            {batch.reasoning && (
              <div>
                <span className="font-medium text-slate-500">Reasoning:</span>
                <p className="mt-0.5 whitespace-pre-wrap text-slate-600">
                  {batch.reasoning}
                </p>
              </div>
            )}

            {/* 7th char authority */}
            {batch.sevenChrAuthority && (
              <div>
                <span className="font-medium text-slate-500">
                  7th Char Authority:
                </span>
                <span className="ml-1 font-mono text-slate-600">
                  {Object.keys(batch.sevenChrAuthority).join(", ")}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
