from __future__ import annotations

import logging
from typing import Any, AsyncGenerator, Dict

from burr.core import ApplicationContext, Condition, State, default
from burr.core.action import action
from burr.core.graph import GraphBuilder
from burr.core.parallelism import RunnableGraph, SubGraphTask, TaskBasedParallelAction

from agent.actions import (
    _parse_batch_id,
    _pad_code_to_depth6,
    finish,
    finish_batch,
    get_node,
    load_node,
    select_candidates,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cached traversal graph (built once, used by all sub-tasks)
# ---------------------------------------------------------------------------

_TRAVERSAL_GRAPH: RunnableGraph | None = None


def _should_spawn(state: State) -> bool:
    """Condition: children batch with non-empty selection → fan out."""
    bid = state["current_batch_id"]
    _, bt = _parse_batch_id(bid)
    bd = state["batch_data"].get(bid, {})
    return bt == "children" and bool(bd.get("selected_ids"))


def get_traversal_graph() -> RunnableGraph:
    """Lazily build and cache the recursive traversal graph."""
    global _TRAVERSAL_GRAPH
    if _TRAVERSAL_GRAPH is not None:
        return _TRAVERSAL_GRAPH

    graph = (
        GraphBuilder()
        .with_actions(
            load_node=load_node,
            select_candidates=select_candidates,
            spawn_batches=SpawnBatches(),
            finish_batch=finish_batch,
            finish=finish,
        )
        .with_transitions(
            ("load_node", "select_candidates", default),
            (
                "select_candidates",
                "spawn_batches",
                Condition.lmda(
                    _should_spawn,
                    state_keys=["current_batch_id", "batch_data"],
                ),
            ),
            ("select_candidates", "finish_batch", default),
            ("spawn_batches", "finish", default),
            ("finish_batch", "finish", default),
        )
        .build()
    )
    _TRAVERSAL_GRAPH = RunnableGraph(
        graph=graph, entrypoint="load_node", halt_after=["finish"]
    )
    return _TRAVERSAL_GRAPH


# ---------------------------------------------------------------------------
# SpawnBatches — async parallel fan-out
# ---------------------------------------------------------------------------


class SpawnBatches(TaskBasedParallelAction):
    """For each selected code, spawn child + lateral + sevenChrDef sub-tasks."""

    @property
    def reads(self) -> list[str]:
        return ["current_batch_id", "batch_data", "context", "prompt_builder", "final_nodes"]

    @property
    def writes(self) -> list[str]:
        return ["batch_data", "final_nodes"]

    def is_async(self) -> bool:
        return True

    async def tasks(
        self,
        state: State,
        context: ApplicationContext,
        inputs: Dict[str, Any],
    ) -> AsyncGenerator[SubGraphTask, None]:
        batch_id = state["current_batch_id"]
        batch_data: dict = state["batch_data"]
        bd = batch_data[batch_id]
        selected_ids: list[str] = bd["selected_ids"]
        seven_chr_authority = bd.get("seven_chr_authority")

        graph = get_traversal_graph()
        task_idx = 0

        for code in selected_ids:
            try:
                node = get_node(code)
            except KeyError:
                logger.warning("Selected code %s not found in index, skipping", code)
                continue

            has_children = bool(node.get("children"))
            node_depth = node["depth"]

            if has_children:
                # Continue descent into children
                child_bid = f"{code}|children"
                yield SubGraphTask(
                    graph=graph,
                    inputs={},
                    state=state.update(current_batch_id=child_bid),
                    application_id=f"{context.app_id}:sub_{task_idx}",
                )
                task_idx += 1
            elif seven_chr_authority:
                # Leaf with 7th char authority → create sevenChrDef batch
                padded = _pad_code_to_depth6(code, node_depth)
                schr_bid = f"{padded}|sevenChrDef"

                # Pre-populate batch_data so load_node finds candidates
                pre_bd = dict(batch_data)
                pre_bd[schr_bid] = {
                    "node_id": padded,
                    "batch_type": "sevenChrDef",
                    "parent_id": code,
                    "depth": 6,
                    "candidates": dict(seven_chr_authority),
                    "selected_ids": [],
                    "reasoning": "",
                    "seven_chr_authority": seven_chr_authority,
                }
                yield SubGraphTask(
                    graph=graph,
                    inputs={},
                    state=state.update(
                        current_batch_id=schr_bid, batch_data=pre_bd
                    ),
                    application_id=f"{context.app_id}:sub_{task_idx}",
                )
                task_idx += 1
            else:
                # True leaf — finalize via a trivial sub-task
                leaf_g = (
                    GraphBuilder()
                    .with_actions(finalize_leaf=_finalize_leaf)
                    .build()
                )
                leaf_graph = RunnableGraph(
                    graph=leaf_g,
                    entrypoint="finalize_leaf",
                    halt_after=["finalize_leaf"],
                )
                yield SubGraphTask(
                    graph=leaf_graph,
                    inputs={},
                    state=state.update(current_batch_id=code),
                    application_id=f"{context.app_id}:sub_{task_idx}",
                )
                task_idx += 1

            # Lateral batches (for every selected code, leaf or not)
            for lateral_type in ("codeFirst", "codeAlso", "useAdditionalCode"):
                if node.get("metadata", {}).get(lateral_type):
                    lat_bid = f"{code}|{lateral_type}"
                    yield SubGraphTask(
                        graph=graph,
                        inputs={},
                        state=state.update(current_batch_id=lat_bid),
                        application_id=f"{context.app_id}:sub_{task_idx}",
                    )
                    task_idx += 1

        logger.info(
            "SpawnBatches for %s: created %d sub-tasks from %d selections",
            batch_id, task_idx, len(selected_ids),
        )

    async def reduce(
        self,
        state: State,
        states: AsyncGenerator[State, None],
    ) -> State:
        batch_data = dict(state.get("batch_data", {}))
        final_nodes = list(state.get("final_nodes", []))

        async for sub_state in states:
            # Merge batch_data
            for k, v in sub_state.get("batch_data", {}).items():
                if k not in batch_data:
                    batch_data[k] = v
            # Merge final_nodes
            sub_finals = sub_state.get("final_nodes", [])
            final_nodes.extend(sub_finals)

        return state.update(batch_data=batch_data, final_nodes=final_nodes)


# ---------------------------------------------------------------------------
# Trivial leaf finalizer action
# ---------------------------------------------------------------------------


@action(reads=["current_batch_id", "final_nodes"], writes=["final_nodes"])
def _finalize_leaf(state: State) -> tuple[dict, State]:
    """Finalize a leaf code that needs no further traversal."""
    code = state["current_batch_id"]
    final_nodes = list(state.get("final_nodes", []))
    final_nodes.append(code)
    logger.info("Finalized leaf code (direct): %s", code)
    return {}, state.update(final_nodes=final_nodes)
