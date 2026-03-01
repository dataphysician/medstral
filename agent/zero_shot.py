from __future__ import annotations

import logging

from burr.core import ApplicationBuilder, State, default
from burr.core.action import action
from burr.core.graph import GraphBuilder
from burr.integrations.persisters.b_aiosqlite import AsyncSQLitePersister

from agent import llm
from agent.llm import call_llm
from agent.prompts import DefaultZeroShotPrompt, PromptBuilder
from agent.traversal import DB_PATH

logger = logging.getLogger(__name__)

ZS_TABLE = "zero_shot_state"

_ZS_PERSISTER: AsyncSQLitePersister | None = None


async def _get_zs_persister() -> AsyncSQLitePersister:
    global _ZS_PERSISTER
    if _ZS_PERSISTER is None:
        _ZS_PERSISTER = await AsyncSQLitePersister.from_values(
            db_path=DB_PATH, table_name=ZS_TABLE
        )
        await _ZS_PERSISTER.initialize()
    return _ZS_PERSISTER


# ---------------------------------------------------------------------------
# Zero-shot action
# ---------------------------------------------------------------------------


@action(
    reads=["context", "prompt_builder"],
    writes=["final_nodes", "reasoning"],
)
async def zero_shot_selection(state: State) -> tuple[dict, State]:
    """Single LLM call to generate ICD-10 codes directly."""
    context: str = state["context"]
    pb: PromptBuilder = state.get("prompt_builder") or DefaultZeroShotPrompt()
    config = llm.LLM_CONFIG
    if config is None:
        raise RuntimeError("LLM_CONFIG not set")

    messages = pb.build_messages(context, "", {})
    codes, reasoning = await call_llm(messages, config)

    logger.info("Zero-shot returned %d codes: %s", len(codes), codes)
    return (
        {"final_nodes": codes, "reasoning": reasoning},
        state.update(final_nodes=codes, reasoning=reasoning),
    )


@action(reads=["final_nodes"], writes=[])
def zs_finish(state: State) -> tuple[dict, State]:
    """Terminal state for zero-shot."""
    final = state.get("final_nodes", [])
    logger.info("Zero-shot finished with %d codes: %s", len(final), final)
    return {"final_nodes": final}, state


# ---------------------------------------------------------------------------
# App builder
# ---------------------------------------------------------------------------


async def build_zero_shot_app(
    clinical_note: str,
    partition_key: str,
    prompt_builder: PromptBuilder | None = None,
    persist_cache: bool = True,
) -> tuple[object, bool]:
    """Build (or resume) a zero-shot Burr application.

    When *persist_cache* is False the SQLite cache is bypassed entirely.
    """
    pb = prompt_builder or DefaultZeroShotPrompt()
    app_id = f"zeroshot_{partition_key[:24]}"

    persister = await _get_zs_persister() if persist_cache else None

    # Cache check (only when caching is enabled)
    if persister is not None:
        cached = await persister.load(partition_key=partition_key, app_id=app_id)
        if cached is not None:
            cached_state: State = cached["state"]
            final = cached_state.get("final_nodes", [])
            if final:
                logger.info("Zero-shot cache hit: %d codes", len(final))
                graph = (
                    GraphBuilder()
                    .with_actions(
                        zero_shot_selection=zero_shot_selection,
                        finish=zs_finish,
                    )
                    .with_transitions(("zero_shot_selection", "finish", default))
                    .build()
                )
                app = await (
                    ApplicationBuilder()
                    .with_graph(graph)
                    .with_entrypoint("finish")
                    .with_state(cached_state)
                    .with_identifiers(app_id=app_id, partition_key=partition_key)
                    .with_state_persister(persister)
                    .abuild()
                )
                return app, True

    graph = (
        GraphBuilder()
        .with_actions(
            zero_shot_selection=zero_shot_selection,
            finish=zs_finish,
        )
        .with_transitions(("zero_shot_selection", "finish", default))
        .build()
    )

    initial_state = State({
        "context": clinical_note,
        "prompt_builder": pb,
        "final_nodes": [],
        "reasoning": "",
    })

    builder = (
        ApplicationBuilder()
        .with_graph(graph)
        .with_entrypoint("zero_shot_selection")
        .with_state(initial_state)
        .with_identifiers(app_id=app_id, partition_key=partition_key)
    )
    if persister is not None:
        builder = builder.with_state_persister(persister)
    app = await builder.abuild()
    return app, False


async def cleanup_zs_persister() -> None:
    global _ZS_PERSISTER
    if _ZS_PERSISTER is not None:
        await _ZS_PERSISTER.cleanup()
        _ZS_PERSISTER = None
