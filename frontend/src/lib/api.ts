import { streamSSE, type StreamHandle } from "./agent";
import type { AGUIEvent, LLMSettings } from "./types";

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
