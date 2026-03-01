import { useMemo } from "react";
import { sortBatchesDFS } from "../lib/parse";
import type { BatchDecision, TraversalRun } from "../lib/types";
import BatchStep from "./BatchStep";
import TraversalProgress from "./TraversalProgress";

interface Props {
  run: TraversalRun;
  expandedBatchIds: ReadonlySet<string>;
  selectedBatchId?: string | null;
  onToggleBatch: (batchId: string) => void;
  onBatchSelect?: (batch: BatchDecision) => void;
  onCodeSelect?: (code: string) => void;
}

export default function TraversalResult({
  run,
  expandedBatchIds,
  selectedBatchId,
  onToggleBatch,
  onBatchSelect,
  onCodeSelect,
}: Props) {
  const seconds = (run.elapsedMs / 1000).toFixed(1);
  const sortedBatches = useMemo(
    () => sortBatchesDFS(run.batches),
    [run.batches],
  );

  return (
    <div className="space-y-3">
      {/* Batch steps */}
      {sortedBatches.length > 0 && (
        <div className="space-y-0.5">
          {sortedBatches.map((batch) => (
            <BatchStep
              key={batch.batchId}
              batch={batch}
              expanded={expandedBatchIds.has(batch.batchId)}
              selected={selectedBatchId === batch.batchId}
              onToggle={onToggleBatch}
              onSelect={onBatchSelect}
            />
          ))}
        </div>
      )}

      {/* Progress indicator while traversing */}
      {run.status === "traversing" && (
        <TraversalProgress
          batchCount={run.batches.length}
          elapsedMs={run.elapsedMs}
        />
      )}

      {/* Error */}
      {run.status === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Error: {run.error}
        </div>
      )}

      {/* Final codes */}
      {run.status === "complete" && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold text-green-800">
              Final ICD-10-CM Codes
            </span>
            {run.cached && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                cached
              </span>
            )}
            <span className="text-xs text-green-600">
              {run.finalCodes.length} codes &middot; {seconds}s &middot;{" "}
              {run.batches.length} batches
            </span>
          </div>
          {run.finalCodes.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {run.finalCodes.map((code) => (
                <button
                  key={code}
                  onClick={() => onCodeSelect?.(code)}
                  className="rounded-md bg-green-100 px-2 py-1 font-mono text-sm
                             font-semibold text-green-800 hover:bg-green-200
                             hover:ring-1 hover:ring-green-400 transition-colors"
                >
                  {code}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-green-600">
              No codes selected for this clinical note.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
