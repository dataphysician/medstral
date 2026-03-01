from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from burr.core import ApplicationBuilder, State
from burr.integrations.persisters.b_aiosqlite import AsyncSQLitePersister

from agent.parallel import get_traversal_graph
from agent.prompts import DefaultScaffoldedPrompt, PromptBuilder

logger = logging.getLogger(__name__)

DB_PATH = str(Path(__file__).resolve().parent.parent / "medstral.sqlite")
TABLE_NAME = "traversal_state"

# Module-level persister (initialized once, reused)
_PERSISTER: AsyncSQLitePersister | None = None


async def _get_persister() -> AsyncSQLitePersister:
    global _PERSISTER
    if _PERSISTER is None:
        _PERSISTER = await AsyncSQLitePersister.from_values(
            db_path=DB_PATH, table_name=TABLE_NAME
        )
        await _PERSISTER.initialize()
    return _PERSISTER


def generate_traversal_cache_key(
    clinical_note: str,
    model: str = "mistral-small-latest",
    temperature: float = 0.0,
) -> str:
    """Deterministic SHA-256 hash for partition_key."""
    blob = f"{clinical_note}|{model}|{temperature}"
    return hashlib.sha256(blob.encode()).hexdigest()


async def build_traversal_app(
    context: str,
    partition_key: str,
    prompt_builder: PromptBuilder | None = None,
    persist_cache: bool = True,
) -> tuple[object, bool]:
    """Build (or resume) a Burr traversal application.

    Returns (app, cached: bool). If cached is True the app's state already
    contains final_nodes from a prior run and no further execution is needed.

    When *persist_cache* is False the SQLite cache is bypassed entirely:
    no lookup is performed and results are not persisted.
    """
    pb = prompt_builder or DefaultScaffoldedPrompt()
    graph = get_traversal_graph()
    app_id = f"traversal_{partition_key[:24]}"

    persister = await _get_persister() if persist_cache else None

    # Check for cached run (only when caching is enabled)
    if persister is not None:
        cached_data = await persister.load(
            partition_key=partition_key, app_id=app_id
        )
        if cached_data is not None:
            cached_state: State = cached_data["state"]
            final_nodes = cached_state.get("final_nodes", [])
            if final_nodes:
                logger.info(
                    "Cache hit for %s: %d final codes", app_id, len(final_nodes)
                )
                app = await (
                    ApplicationBuilder()
                    .with_graph(graph.graph)
                    .with_entrypoint("finish")
                    .with_state(cached_state)
                    .with_identifiers(app_id=app_id, partition_key=partition_key)
                    .with_state_persister(persister)
                    .abuild()
                )
                return app, True

    # Fresh run
    initial_state = State({
        "current_batch_id": "ROOT",
        "batch_data": {},
        "final_nodes": [],
        "context": context,
        "prompt_builder": pb,
    })
    builder = (
        ApplicationBuilder()
        .with_graph(graph.graph)
        .with_entrypoint(graph.entrypoint)
        .with_state(initial_state)
        .with_identifiers(app_id=app_id, partition_key=partition_key)
    )
    if persister is not None:
        builder = builder.with_state_persister(persister)
    app = await builder.abuild()
    return app, False


async def retry_node(
    batch_id: str,
    clinical_note: str,
    partition_key: str,
    prompt_builder: PromptBuilder | None = None,
) -> State:
    """Rewind to a specific node: prune downstream state and re-traverse.

    1. Load the latest checkpoint
    2. Prune: remove the batch and all descendants
    3. Set current_batch_id and optionally a new prompt_builder
    4. Fork the app and run from select_candidates
    5. Return the final state
    """
    persister = await _get_persister()
    graph = get_traversal_graph()
    app_id = f"traversal_{partition_key[:24]}"

    cached = await persister.load(partition_key=partition_key, app_id=app_id)
    if cached is None:
        raise ValueError(f"No cached state found for {app_id}")

    old_state: State = cached["state"]
    old_seq_id: int = cached["sequence_id"]
    batch_data: dict = dict(old_state["batch_data"])

    # Prune: remove batch_id and all descendants
    batch_data = _prune_batch_data(batch_data, batch_id)

    # Reset the target batch's selection
    if batch_id in batch_data:
        bd = dict(batch_data[batch_id])
        bd["selected_ids"] = []
        bd["reasoning"] = ""
        batch_data[batch_id] = bd

    pb = prompt_builder or old_state.get("prompt_builder") or DefaultScaffoldedPrompt()

    new_state = old_state.update(
        current_batch_id=batch_id,
        batch_data=batch_data,
        final_nodes=[],  # reset — rewind replaces the subtree
        prompt_builder=pb,
    )

    fork_app_id = f"{app_id}_rewind_{old_seq_id + 1}"

    app = await (
        ApplicationBuilder()
        .with_graph(graph.graph)
        .with_entrypoint("select_candidates")
        .with_state(new_state)
        .with_identifiers(app_id=fork_app_id, partition_key=partition_key)
        .with_state_persister(persister)
        .abuild()
    )

    _, _, final_state = await app.arun(
        halt_after=["finish"], inputs={}
    )

    # Also save updated state back under original app_id
    await persister.save(
        partition_key=partition_key,
        app_id=app_id,
        sequence_id=old_seq_id + 1,
        position="finish",
        state=final_state,
        status="completed",
    )

    return final_state


def _prune_batch_data(
    batch_data: dict, target_batch_id: str
) -> dict:
    """Remove the target batch and all batches that descend from it."""
    target_node, _ = target_batch_id.rsplit("|", 1) if "|" in target_batch_id else (target_batch_id, "children")
    pruned = {}
    for bid, bd in batch_data.items():
        node_id = bd.get("node_id", "")
        # Keep if it's not a descendant of the target
        if not _is_descendant(node_id, target_node) and bid != target_batch_id:
            pruned[bid] = bd
    return pruned


def _is_descendant(node_id: str, ancestor_id: str) -> bool:
    """Check if node_id is a descendant of ancestor_id in the ICD-10 hierarchy."""
    if node_id == ancestor_id:
        return False
    # Simple prefix check on normalized codes
    n = node_id.replace(".", "").upper()
    a = ancestor_id.replace(".", "").upper()
    return n.startswith(a)


async def cleanup_persister() -> None:
    """Close the persister connection."""
    global _PERSISTER
    if _PERSISTER is not None:
        await _PERSISTER.cleanup()
        _PERSISTER = None
