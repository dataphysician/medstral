// ---------------------------------------------------------------------------
// LLM configuration
// ---------------------------------------------------------------------------

export interface LLMSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  scaffolded: boolean;
  persistCache: boolean;
}

export const DEFAULT_SETTINGS: LLMSettings = {
  model: "mistral-small-latest",
  temperature: 0.0,
  maxTokens: 8000,
  scaffolded: true,
  persistCache: false,
};

// ---------------------------------------------------------------------------
// Traversal data (mirrors backend BatchData / server events)
// ---------------------------------------------------------------------------

export interface PromptMessage {
  role: string;
  content: string;
}

export interface BatchDecision {
  batchId: string;
  nodeId: string;
  parentId: string | null;
  depth: number;
  batchType: string;
  candidates: Record<string, string>;
  selectedIds: string[];
  reasoning: string;
  sevenChrAuthority: Record<string, string> | null;
  promptMessages: PromptMessage[];
}

export type RunStatus = "idle" | "traversing" | "complete" | "error";

export interface TraversalRun {
  id: string;
  status: RunStatus;
  clinicalNote: string;
  batches: BatchDecision[];
  finalCodes: string[];
  error: string | null;
  startTime: number;
  elapsedMs: number;
  cached: boolean;
  gepaLog: GepaLogEntry[];
  gepaResult: GepaResult | null;
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  run?: TraversalRun;
}

// ---------------------------------------------------------------------------
// Evaluate & Optimize types
// ---------------------------------------------------------------------------

export interface GoldTrajectory {
  goldCode: string;
  trajectory: Record<string, string>;
  maxDepth: number;
}

export interface PathComparison {
  depth: number;
  batchId: string;
  predNode: string;
  goldNode: string | null;
  match: boolean;
}

export interface DivergenceResult {
  goldCode: string;
  predCode: string;
  divergenceDepth: number | null;
  divergenceBatchId: string | null;
  lcp: string;
  score: number;
  path: PathComparison[];
  feedback: string;
}

// ---------------------------------------------------------------------------
// GEPA optimization types
// ---------------------------------------------------------------------------

export interface GepaLogEntry {
  type: "log" | "mutation" | "accepted" | "rejected" | "base_score" | "iteration_start";
  iteration: number;
  message: string;
  timestamp: number;
  component?: string;
  oldText?: string;
  newText?: string;
  score?: number;
}

export interface GepaResult {
  bestCandidate: Record<string, string>;
  bestScore: number;
  candidates: { candidate: Record<string, string>; score: number }[];
  totalIterations: number;
}

// ---------------------------------------------------------------------------
// AG-UI event types — discriminated union matching the wire format
// (SCREAMING_SNAKE_CASE type values, camelCase field names)
// ---------------------------------------------------------------------------

/** Raw per-batch snapshot from the server (snake_case keys in snapshot body). */
export interface BatchSnapshot {
  batch_id: string;
  node_id: string;
  parent_id: string | null;
  depth: number;
  candidates: Record<string, string>;
  selected_ids: string[];
  reasoning: string;
  seven_chr_authority: Record<string, string> | null;
}

/** Full-state snapshot: batch_data map + final_nodes list. */
export interface FullStateSnapshot {
  batch_data: Record<string, BatchSnapshotEntry>;
  final_nodes: string[];
}

/** A single entry inside batch_data (full-state snapshot). */
export interface BatchSnapshotEntry {
  node_id: string;
  parent_id: string | null;
  depth: number;
  batch_type: string;
  candidates: Record<string, string>;
  selected_ids: string[];
  reasoning: string;
  seven_chr_authority: Record<string, string> | null;
}

export type AGUIEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string }
  | { type: "RUN_FINISHED"; threadId: string; runId: string }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "STATE_SNAPSHOT"; snapshot: Record<string, unknown> }
  | { type: "STEP_STARTED"; stepName: string }
  | { type: "STEP_FINISHED"; stepName: string }
  | { type: "CUSTOM"; name: string; value: unknown };
