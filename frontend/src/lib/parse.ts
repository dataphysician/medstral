import type {
  AGUIEvent,
  BatchDecision,
  BatchSnapshot,
  FullStateSnapshot,
  LLMSettings,
  PromptMessage,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// ---------------------------------------------------------------------------
// AG-UI event validation
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "STATE_SNAPSHOT",
  "STEP_STARTED",
  "STEP_FINISHED",
  "CUSTOM",
]);

/** Validate that a parsed JSON value is a known AG-UI event. */
export function parseAGUIEvent(raw: unknown): AGUIEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["type"] !== "string") return null;
  if (!KNOWN_EVENT_TYPES.has(obj["type"])) return null;
  return obj as unknown as AGUIEvent;
}

// ---------------------------------------------------------------------------
// Batch snapshot validation
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  for (const val of Object.values(v)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function parsePromptMessages(v: unknown): PromptMessage[] {
  if (!Array.isArray(v)) return [];
  const result: PromptMessage[] = [];
  for (const item of v) {
    if (isRecord(item) && typeof item["role"] === "string" && typeof item["content"] === "string") {
      result.push({ role: item["role"], content: item["content"] });
    }
  }
  return result;
}

/** Check if a snapshot is a per-batch snapshot (has batch_id + node_id). */
export function isBatchSnapshot(s: Record<string, unknown>): s is BatchSnapshot & Record<string, unknown> {
  return typeof s["batch_id"] === "string" && typeof s["node_id"] === "string";
}

/** Check if a snapshot is a full-state snapshot (has batch_data dict). */
export function isFullStateSnapshot(s: Record<string, unknown>): s is FullStateSnapshot & Record<string, unknown> {
  return isRecord(s["batch_data"]) && Array.isArray(s["final_nodes"]);
}

// ---------------------------------------------------------------------------
// Conversion from raw snapshots to typed BatchDecision
// ---------------------------------------------------------------------------

function inferBatchType(batchId: string): string {
  const idx = batchId.lastIndexOf("|");
  return idx >= 0 ? batchId.slice(idx + 1) : "children";
}

/** Convert a validated per-batch snapshot into a BatchDecision. */
export function batchSnapshotToDecision(s: Record<string, unknown>): BatchDecision {
  const batchId = String(s["batch_id"] ?? "");
  const candidates = isStringRecord(s["candidates"]) ? s["candidates"] : {};
  const selectedIds = isStringArray(s["selected_ids"]) ? s["selected_ids"] : [];
  const sevenChr = isStringRecord(s["seven_chr_authority"]) ? s["seven_chr_authority"] : null;

  return {
    batchId,
    nodeId: String(s["node_id"] ?? ""),
    parentId: typeof s["parent_id"] === "string" ? s["parent_id"] : null,
    depth: typeof s["depth"] === "number" ? s["depth"] : -1,
    batchType: inferBatchType(batchId),
    candidates,
    selectedIds,
    reasoning: typeof s["reasoning"] === "string" ? s["reasoning"] : "",
    sevenChrAuthority: sevenChr,
    promptMessages: parsePromptMessages(s["prompt_messages"]),
  };
}

/** Convert a full-state batch_data entry to a BatchDecision. */
export function batchEntryToDecision(batchId: string, bd: Record<string, unknown>): BatchDecision {
  const candidates = isStringRecord(bd["candidates"]) ? bd["candidates"] : {};
  const selectedIds = isStringArray(bd["selected_ids"]) ? bd["selected_ids"] : [];
  const sevenChr = isStringRecord(bd["seven_chr_authority"]) ? bd["seven_chr_authority"] : null;

  return {
    batchId,
    nodeId: String(bd["node_id"] ?? ""),
    parentId: typeof bd["parent_id"] === "string" ? bd["parent_id"] : null,
    depth: typeof bd["depth"] === "number" ? bd["depth"] : -1,
    batchType: typeof bd["batch_type"] === "string" ? bd["batch_type"] : inferBatchType(batchId),
    candidates,
    selectedIds,
    reasoning: typeof bd["reasoning"] === "string" ? bd["reasoning"] : "",
    sevenChrAuthority: sevenChr,
    promptMessages: parsePromptMessages(bd["prompt_messages"]),
  };
}

/** Extract final codes + all batch decisions from a full-state snapshot. */
export function extractFullState(snapshot: Record<string, unknown>): {
  finalCodes: string[];
  allBatches: BatchDecision[];
} {
  const rawFinal = snapshot["final_nodes"];
  const finalCodes = isStringArray(rawFinal) ? rawFinal : [];

  const batchData = snapshot["batch_data"];
  const allBatches: BatchDecision[] = [];

  if (isRecord(batchData)) {
    for (const [batchId, entry] of Object.entries(batchData)) {
      if (isRecord(entry)) {
        allBatches.push(batchEntryToDecision(batchId, entry));
      }
    }
  }

  return { finalCodes, allBatches };
}

// ---------------------------------------------------------------------------
// DFS sort — reorder flat batch list into depth-first traversal order
// ---------------------------------------------------------------------------

const BATCH_TYPE_ORDER: Record<string, number> = {
  children: 0,
  sevenChrDef: 1,
  codeFirst: 2,
  codeAlso: 3,
  useAdditionalCode: 4,
};

function batchTypeRank(t: string): number {
  return BATCH_TYPE_ORDER[t] ?? 99;
}

/**
 * Sort batches into DFS order by reconstructing the traversal tree.
 *
 * The tree structure:
 *   - ROOT batch selects chapter codes
 *   - Each selected code spawns children + lateral batches
 *   - children batch selects deeper codes, recurse
 *   - sevenChrDef batches are linked via parentId (padded code as nodeId)
 */
export function sortBatchesDFS(batches: BatchDecision[]): BatchDecision[] {
  if (batches.length <= 1) return batches;

  // Map: nodeId -> all batches at that node (children, laterals, sevenChrDef)
  const byNode = new Map<string, BatchDecision[]>();
  for (const b of batches) {
    const list = byNode.get(b.nodeId) ?? [];
    list.push(b);
    byNode.set(b.nodeId, list);
  }

  // Map: code -> sevenChrDef batches whose parentId is that code
  // (sevenChrDef nodeId is the X-padded form, not the original selected code)
  const sevenChrByParent = new Map<string, BatchDecision[]>();
  for (const b of batches) {
    if (b.batchType === "sevenChrDef" && b.parentId) {
      const list = sevenChrByParent.get(b.parentId) ?? [];
      list.push(b);
      sevenChrByParent.set(b.parentId, list);
    }
  }

  const result: BatchDecision[] = [];
  const visited = new Set<string>();

  function visitCode(code: string) {
    // Get all batches at this node, sorted: children first, then laterals
    const nodeBatches = byNode.get(code);
    if (!nodeBatches) return;

    const sorted = [...nodeBatches].sort(
      (a, b) => batchTypeRank(a.batchType) - batchTypeRank(b.batchType),
    );

    for (const batch of sorted) {
      if (visited.has(batch.batchId)) continue;
      visited.add(batch.batchId);
      result.push(batch);

      // Recurse into each selected code (DFS)
      for (const childCode of batch.selectedIds) {
        visitCode(childCode);

        // Check for sevenChrDef batches linked to this child via parentId
        const schrBatches = sevenChrByParent.get(childCode);
        if (schrBatches) {
          for (const schr of schrBatches) {
            if (!visited.has(schr.batchId)) {
              visited.add(schr.batchId);
              result.push(schr);
            }
          }
        }
      }
    }
  }

  visitCode("ROOT");

  // Append any unvisited batches (orphans from edge cases)
  for (const b of batches) {
    if (!visited.has(b.batchId)) {
      result.push(b);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Code ancestry path — trace from ROOT to a finalized code
// ---------------------------------------------------------------------------

/**
 * Build the ancestry path of batches from ROOT down to a finalized code.
 *
 * Walks the selection chain backwards: find the batch whose selectedIds
 * contains the code, then find who selected that batch's nodeId, etc.
 * Returns the path top-down (ROOT first, terminal batch last).
 */
export function buildCodePath(
  finalCode: string,
  batches: BatchDecision[],
): BatchDecision[] {
  // Map: code → batch that selected it
  const selectedBy = new Map<string, BatchDecision>();
  for (const b of batches) {
    if (b.batchType === "sevenChrDef") {
      // sevenChrDef: final code = nodeId + selected char
      for (const ch of b.selectedIds) {
        selectedBy.set(b.nodeId + ch, b);
      }
    } else {
      for (const code of b.selectedIds) {
        selectedBy.set(code, b);
      }
    }
  }

  const path: BatchDecision[] = [];
  let current = finalCode;

  // Walk upward through the selection chain
  while (current !== "ROOT") {
    const batch = selectedBy.get(current);
    if (!batch) break;
    path.unshift(batch);
    current = batch.nodeId;
  }

  // Ensure ROOT is at the top
  if (path.length === 0 || path[0]?.nodeId !== "ROOT") {
    const rootBatch = batches.find(
      (b) => b.nodeId === "ROOT" && b.batchType === "children",
    );
    if (rootBatch) {
      path.unshift(rootBatch);
    }
  }

  return path;
}

// ---------------------------------------------------------------------------
// LLMSettings validation (for localStorage)
// ---------------------------------------------------------------------------

/** Validate and merge a parsed JSON object into LLMSettings. */
export function parseLLMSettings(raw: unknown): LLMSettings {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;

  return {
    model:
      typeof raw["model"] === "string" && raw["model"].length > 0
        ? raw["model"]
        : DEFAULT_SETTINGS.model,
    temperature:
      typeof raw["temperature"] === "number" && !Number.isNaN(raw["temperature"])
        ? Math.max(0, Math.min(1, raw["temperature"]))
        : DEFAULT_SETTINGS.temperature,
    maxTokens:
      typeof raw["maxTokens"] === "number" &&
      Number.isInteger(raw["maxTokens"]) &&
      raw["maxTokens"] >= 256
        ? raw["maxTokens"]
        : DEFAULT_SETTINGS.maxTokens,
    scaffolded:
      typeof raw["scaffolded"] === "boolean"
        ? raw["scaffolded"]
        : DEFAULT_SETTINGS.scaffolded,
    persistCache:
      typeof raw["persistCache"] === "boolean"
        ? raw["persistCache"]
        : DEFAULT_SETTINGS.persistCache,
  };
}
