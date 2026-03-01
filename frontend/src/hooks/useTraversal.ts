import { useCallback, useRef, useState } from "react";
import { streamTraversal } from "../lib/api";
import type { StreamHandle } from "../lib/agent";
import {
  batchSnapshotToDecision,
  extractFullState,
  isBatchSnapshot,
  isFullStateSnapshot,
} from "../lib/parse";
import type {
  AGUIEvent,
  BatchDecision,
  LLMSettings,
  TraversalRun,
} from "../lib/types";

function makeRun(clinicalNote: string): TraversalRun {
  return {
    id: crypto.randomUUID(),
    status: "traversing",
    clinicalNote,
    batches: [],
    finalCodes: [],
    error: null,
    startTime: Date.now(),
    elapsedMs: 0,
    cached: false,
  };
}

export function useTraversal() {
  const [run, setRun] = useState<TraversalRun | null>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchesRef = useRef<BatchDecision[]>([]);
  const gotStepRef = useRef(false);

  const stop = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(
    (clinicalNote: string, settings: LLMSettings) => {
      stop();
      const newRun = makeRun(clinicalNote);
      batchesRef.current = [];
      gotStepRef.current = false;
      setRun(newRun);

      // Elapsed time ticker
      timerRef.current = setInterval(() => {
        setRun((prev) =>
          prev && prev.status === "traversing"
            ? { ...prev, elapsedMs: Date.now() - prev.startTime }
            : prev,
        );
      }, 200);

      const handleEvent = (event: AGUIEvent) => {
        switch (event.type) {
          case "RUN_STARTED":
            // Already set up
            break;

          case "STEP_STARTED":
            gotStepRef.current = true;
            break;

          case "STATE_SNAPSHOT": {
            const snapshot = event.snapshot;

            // Per-batch snapshot (has batch_id + node_id)?
            if (isBatchSnapshot(snapshot)) {
              const batch = batchSnapshotToDecision(snapshot);
              batchesRef.current = [...batchesRef.current, batch];
              setRun((prev) =>
                prev ? { ...prev, batches: batchesRef.current } : prev,
              );
              break;
            }

            // Full-state snapshot (batch_data + final_nodes)?
            if (isFullStateSnapshot(snapshot)) {
              const { finalCodes, allBatches } = extractFullState(snapshot);
              if (allBatches.length > 0 && !gotStepRef.current) {
                // Cached run: all batches in a single snapshot
                batchesRef.current = allBatches;
              }
              if (finalCodes.length > 0) {
                setRun((prev) =>
                  prev
                    ? {
                        ...prev,
                        batches: batchesRef.current,
                        finalCodes,
                        cached: !gotStepRef.current && allBatches.length > 0,
                      }
                    : prev,
                );
              }
              break;
            }

            // Zero-shot snapshot (final_nodes + reasoning, no batch_data)
            if (Array.isArray(snapshot["final_nodes"])) {
              const rawArr: unknown[] = snapshot["final_nodes"];
              const finalCodes = rawArr.filter(
                (c): c is string => typeof c === "string",
              );
              if (finalCodes.length > 0) {
                setRun((prev) =>
                  prev ? { ...prev, finalCodes } : prev,
                );
              }
            }
            break;
          }

          case "STEP_FINISHED":
            break;

          case "RUN_FINISHED":
            setRun((prev) =>
              prev
                ? {
                    ...prev,
                    status: "complete",
                    elapsedMs: Date.now() - prev.startTime,
                    batches: batchesRef.current,
                  }
                : prev,
            );
            stop();
            break;

          case "RUN_ERROR":
            setRun((prev) =>
              prev
                ? {
                    ...prev,
                    status: "error",
                    error: event.message,
                    elapsedMs: Date.now() - prev.startTime,
                  }
                : prev,
            );
            stop();
            break;

          case "CUSTOM": {
            // Reasoning events: update the matching batch's reasoning
            const val = event.value;
            if (
              event.name === "reasoning" &&
              typeof val === "object" &&
              val !== null &&
              !Array.isArray(val)
            ) {
              const rec = val as Record<string, unknown>;
              const batchId = typeof rec["batch_id"] === "string" ? rec["batch_id"] : null;
              const reasoning = typeof rec["reasoning"] === "string" ? rec["reasoning"] : null;
              if (batchId && reasoning) {
                const batches = batchesRef.current;
                const idx = batches.findIndex((b) => b.batchId === batchId);
                if (idx >= 0) {
                  const target = batches[idx];
                  if (target) {
                    const updated = [...batches];
                    updated[idx] = { ...target, reasoning };
                    batchesRef.current = updated;
                    setRun((prev) =>
                      prev ? { ...prev, batches: updated } : prev,
                    );
                  }
                }
              }
            }
            break;
          }
        }
      };

      const handleError = (err: Error) => {
        setRun((prev) =>
          prev
            ? {
                ...prev,
                status: "error",
                error: err.message,
                elapsedMs: Date.now() - prev.startTime,
              }
            : prev,
        );
        stop();
      };

      const handleDone = () => {
        setRun((prev) => {
          if (prev && prev.status === "traversing") {
            return {
              ...prev,
              status: "complete",
              elapsedMs: Date.now() - prev.startTime,
            };
          }
          return prev;
        });
        stop();
      };

      handleRef.current = streamTraversal(
        clinicalNote,
        settings,
        handleEvent,
        handleError,
        handleDone,
      );
    },
    [stop],
  );

  return { run, start, stop } as const;
}
