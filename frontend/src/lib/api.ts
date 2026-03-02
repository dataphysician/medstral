import { streamSSE, type StreamHandle } from "./agent";
import type { AGUIEvent, GoldTrajectory, LLMSettings } from "./types";

/**
 * Start a streaming traversal. Returns a handle to abort.
 *
 * The body wraps our config inside AG-UI's RunAgentInput envelope
 * (thread_id, run_id, state = our TraversalRequest fields).
 */
export function streamTraversal(
  clinicalNote: string,
  settings: LLMSettings,
  onEvent: (event: AGUIEvent) => void,
  onError: (err: Error) => void,
  onDone: () => void,
): StreamHandle {
  const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  // Full RunAgentInput envelope (AG-UI spec — camelCase field names)
  const body = {
    threadId,
    runId,
    state: {
      clinical_note: clinicalNote,
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      scaffolded: settings.scaffolded,
      persist_cache: settings.persistCache,
    },
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  return streamSSE("/api/traverse/stream", body, onEvent, onError, onDone);
}

/**
 * Fetch the gold trajectory for an ICD-10-CM code.
 * Returns the depth-indexed trajectory from the backend.
 */
export async function fetchGoldTrajectory(
  goldCode: string,
): Promise<GoldTrajectory> {
  const res = await fetch("/api/evaluate/gold-trajectory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gold_code: goldCode }),
  });
  if (!res.ok) {
    const detail =
      res.status === 404
        ? `Code "${goldCode}" not found in ICD-10-CM index`
        : `HTTP ${res.status}: ${res.statusText}`;
    throw new Error(detail);
  }
  const data: unknown = await res.json();
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid response from gold-trajectory endpoint");
  }
  const rec = data as Record<string, unknown>;
  const trajectory =
    typeof rec["trajectory"] === "object" &&
    rec["trajectory"] !== null &&
    !Array.isArray(rec["trajectory"])
      ? (rec["trajectory"] as Record<string, string>)
      : {};
  return {
    goldCode: typeof rec["gold_code"] === "string" ? rec["gold_code"] : goldCode,
    trajectory,
    maxDepth:
      typeof rec["max_depth"] === "number" ? rec["max_depth"] : 0,
  };
}

/**
 * Start a streaming optimization (rewind + re-traverse with augmented prompt).
 * Uses the AG-UI RunAgentInput envelope for protocol compliance.
 */
export function streamOptimize(
  params: {
    batchId: string;
    clinicalNote: string;
    goldCode: string;
    feedback: string;
  },
  settings: LLMSettings,
  onEvent: (event: AGUIEvent) => void,
  onError: (err: Error) => void,
  onDone: () => void,
): StreamHandle {
  const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  const body = {
    threadId,
    runId,
    state: {
      batch_id: params.batchId,
      clinical_note: params.clinicalNote,
      gold_code: params.goldCode,
      feedback: params.feedback,
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      persist_cache: settings.persistCache,
    },
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  return streamSSE("/api/optimize/stream", body, onEvent, onError, onDone);
}

/**
 * Start GEPA evolutionary prompt optimization.
 * Uses the AG-UI RunAgentInput envelope for protocol compliance.
 */
export function streamGepaOptimize(
  params: {
    clinicalNote: string;
    goldCodes: string[];
    numIters: number;
  },
  settings: LLMSettings,
  onEvent: (event: AGUIEvent) => void,
  onError: (err: Error) => void,
  onDone: () => void,
): StreamHandle {
  const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  const body = {
    threadId,
    runId,
    state: {
      clinical_note: params.clinicalNote,
      gold_codes: params.goldCodes,
      num_iters: params.numIters,
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
    },
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };

  return streamSSE("/api/gepa/optimize/stream", body, onEvent, onError, onDone);
}
