from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable

from burr.core import State
from burr.core.action import action

from agent import llm
from agent.llm import call_llm
from agent.prompts import DefaultScaffoldedPrompt
from agent.state_types import BatchData

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ICD-10-CM index (lazy-loaded, module-level)
# ---------------------------------------------------------------------------

_INDEX: dict[str, Any] | None = None
_INDEX_PATH = Path(__file__).resolve().parent.parent / "static" / "icd10cm.json"


def get_index() -> dict[str, Any]:
    global _INDEX
    if _INDEX is None:
        with open(_INDEX_PATH) as f:
            _INDEX = json.load(f)
        logger.info("Loaded ICD-10-CM index: %d nodes", len(_INDEX))
    return _INDEX


def get_node(node_id: str) -> dict[str, Any]:
    idx = get_index()
    if node_id not in idx:
        raise KeyError(f"Node {node_id!r} not found in ICD-10-CM index")
    return idx[node_id]


def _parse_batch_id(batch_id: str) -> tuple[str, str]:
    """Parse 'node_id|batch_type' → (node_id, batch_type). ROOT → ('ROOT', 'children')."""
    if "|" in batch_id:
        node_id, batch_type = batch_id.rsplit("|", 1)
        return node_id, batch_type
    return batch_id, "children"


def _resolve_seven_chr_authority(node_id: str) -> dict[str, str] | None:
    """Walk up the parent chain to find the nearest ancestor with sevenChrDef."""
    idx = get_index()
    current = node_id
    while current and current in idx:
        node = idx[current]
        scdef = node.get("metadata", {}).get("sevenChrDef")
        if scdef and isinstance(scdef, dict):
            return scdef
        parent_map = node.get("parent", {})
        if not parent_map:
            break
        current = next(iter(parent_map))
    return None


# ---------------------------------------------------------------------------
# Streaming callback
# ---------------------------------------------------------------------------

BATCH_CALLBACK: Callable[..., Any] | None = None

# ---------------------------------------------------------------------------
# Burr actions
# ---------------------------------------------------------------------------


@action(
    reads=["current_batch_id", "batch_data", "context"],
    writes=["batch_data"],
)
def load_node(state: State) -> tuple[dict, State]:
    """Query ICD-10-CM index for candidates at the current batch."""
    batch_id: str = state["current_batch_id"]
    batch_data: dict[str, BatchData] = dict(state.get("batch_data", {}))

    # If batch_data already has this batch with candidates (pre-populated by
    # SpawnBatches for sevenChrDef or virtual nodes), skip the index lookup.
    if batch_id in batch_data and batch_data[batch_id].get("candidates"):
        return {}, state.update(batch_data=batch_data)

    node_id, batch_type = _parse_batch_id(batch_id)

    node = get_node(node_id)
    depth = node["depth"]

    # Resolve candidates based on batch_type
    if batch_type == "children":
        candidates = dict(node.get("children", {}))
    elif batch_type == "sevenChrDef":
        candidates = dict(node.get("metadata", {}).get("sevenChrDef", {}))
    else:
        # codeFirst, codeAlso, useAdditionalCode
        candidates = dict(node.get("metadata", {}).get(batch_type, {}))

    # Determine parent_id from node's parent map
    parent_map = node.get("parent", {})
    parent_id = next(iter(parent_map), None) if parent_map else None

    # Resolve 7th character authority (only for children traversal)
    seven_chr_authority = None
    if batch_type == "children":
        seven_chr_authority = _resolve_seven_chr_authority(node_id)

    bd: BatchData = {
        "node_id": node_id,
        "batch_type": batch_type,
        "parent_id": parent_id,
        "depth": depth,
        "candidates": candidates,
        "selected_ids": [],
        "reasoning": "",
        "seven_chr_authority": seven_chr_authority,
    }
    batch_data[batch_id] = bd

    return {}, state.update(batch_data=batch_data)


@action(
    reads=["current_batch_id", "batch_data", "context", "prompt_builder"],
    writes=["batch_data"],
)
async def select_candidates(state: State) -> tuple[dict, State]:
    """Build prompt, call LLM, store selection in batch_data."""
    batch_id: str = state["current_batch_id"]
    batch_data: dict[str, BatchData] = dict(state["batch_data"])
    bd = dict(batch_data[batch_id])
    context: str = state["context"]

    prompt_builder = state.get("prompt_builder")
    if prompt_builder is None:
        prompt_builder = DefaultScaffoldedPrompt()

    candidates = bd["candidates"]

    # If no candidates, skip LLM call
    if not candidates:
        bd["selected_ids"] = []
        bd["reasoning"] = "No candidates available."
        batch_data[batch_id] = bd
        return {}, state.update(batch_data=batch_data)

    messages = prompt_builder.build_messages(context, batch_id, candidates)

    config = llm.LLM_CONFIG
    if config is None:
        raise RuntimeError("LLM_CONFIG not set. Call configure LLM before traversal.")

    selected_codes, reasoning = await call_llm(messages, config)

    # Validate: keep only codes that are actual candidates
    valid_codes = [c for c in selected_codes if c in candidates]
    if len(valid_codes) != len(selected_codes):
        invalid = set(selected_codes) - set(valid_codes)
        logger.warning(
            "Batch %s: LLM returned invalid codes %s, filtered to %s",
            batch_id, invalid, valid_codes,
        )

    bd["selected_ids"] = valid_codes
    bd["reasoning"] = reasoning
    bd["prompt_messages"] = messages
    batch_data[batch_id] = bd

    # Invoke streaming callback
    if BATCH_CALLBACK is not None:
        BATCH_CALLBACK(
            batch_id=batch_id,
            node_id=bd["node_id"],
            parent_id=bd["parent_id"],
            depth=bd["depth"],
            candidates=candidates,
            selected_ids=valid_codes,
            reasoning=reasoning,
            seven_chr_authority=bd.get("seven_chr_authority"),
            prompt_messages=messages,
        )

    return {}, state.update(batch_data=batch_data)


def _pad_code_to_depth6(code: str, current_depth: int) -> str:
    """Pad a code with 'X' placeholders to reach depth 6 (6-char body after removing dot)."""
    # ICD-10 codes: depth 3 = 3 chars (e.g. S02), depth 4 = 4 chars (S02.1), etc.
    # Target is depth 6 = 6 chars excluding dot
    stripped = code.replace(".", "")
    target_len = 7  # depth 6 means 7 chars in the normalized form (e.g., S021XX)
    while len(stripped) < target_len:
        stripped += "X"
    # Re-insert dot after position 3
    if len(stripped) > 3:
        return stripped[:3] + "." + stripped[3:]
    return stripped


@action(
    reads=["current_batch_id", "batch_data", "final_nodes"],
    writes=["batch_data", "final_nodes"],
)
def finish_batch(state: State) -> tuple[dict, State]:
    """Record batch termination — finalize codes or propagate 7th char."""
    batch_id: str = state["current_batch_id"]
    batch_data: dict[str, BatchData] = dict(state["batch_data"])
    final_nodes: list[str] = list(state.get("final_nodes", []))
    bd = batch_data[batch_id]

    node_id = bd["node_id"]
    batch_type = bd["batch_type"]
    selected_ids = bd["selected_ids"]
    seven_chr_authority = bd.get("seven_chr_authority")

    if batch_type == "sevenChrDef":
        # Format final code: pad parent to depth 6 + append 7th char
        # node_id here is the code that needs the 7th char
        for char_code in selected_ids:
            padded = _pad_code_to_depth6(node_id, bd["depth"])
            final_code = padded + char_code
            final_nodes.append(final_code)
            logger.info("Finalized 7th-char code: %s", final_code)
    elif not selected_ids:
        # Leaf node — no further children selected
        if batch_type == "children" and seven_chr_authority is None:
            # True leaf, add to final
            final_nodes.append(node_id)
            logger.info("Finalized leaf code: %s", node_id)
        # If seven_chr_authority exists, the parallel spawner handles it
    # For lateral batches (codeFirst, codeAlso, useAdditionalCode) with selections,
    # the selected codes are themselves finalized
    elif batch_type in ("codeFirst", "codeAlso", "useAdditionalCode"):
        for code in selected_ids:
            final_nodes.append(code)
            logger.info("Finalized lateral code: %s (via %s)", code, batch_type)

    return {}, state.update(batch_data=batch_data, final_nodes=final_nodes)


@action(
    reads=["final_nodes", "batch_data"],
    writes=["final_nodes"],
)
def finish(state: State) -> tuple[dict, State]:
    """Terminal state — deduplicate and finalize."""
    raw = state.get("final_nodes", [])
    seen: set[str] = set()
    deduped: list[str] = []
    for code in raw:
        if code not in seen:
            seen.add(code)
            deduped.append(code)
    logger.info("Traversal finished with %d final codes: %s", len(deduped), deduped)
    return {"final_nodes": deduped}, state.update(final_nodes=deduped)
