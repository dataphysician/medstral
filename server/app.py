from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from ag_ui.core.events import (
    CustomEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
)
from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder

from agent import llm
from agent.llm import LLMConfig
from agent.prompts import DefaultScaffoldedPrompt
from agent.traversal import (
    build_traversal_app,
    cleanup_persister,
    generate_traversal_cache_key,
    retry_node,
)
from agent.zero_shot import build_zero_shot_app, cleanup_zs_persister
from server.payloads import RewindRequest, TraversalRequest

load_dotenv()

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="MEDSTRAL — ICD-10-CM Agentic Coding")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

encoder = EventEncoder()


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@app.on_event("shutdown")
async def shutdown() -> None:
    await cleanup_persister()
    await cleanup_zs_persister()


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------


def _sse(event: Any) -> str:
    return encoder.encode(event)


def _run_id() -> str:
    return uuid.uuid4().hex[:16]


# ---------------------------------------------------------------------------
# POST /api/traverse/stream — main traversal endpoint (AG-UI SSE)
# ---------------------------------------------------------------------------


@app.post("/api/traverse/stream")
async def traverse_stream(body: RunAgentInput) -> StreamingResponse:
    """Accept RunAgentInput, extract TraversalRequest from state, stream AG-UI events."""
    state_data: dict = body.state or {}
    req = TraversalRequest(**state_data)

    api_key = req.api_key or os.getenv("MISTRAL_API_KEY", "")
    if not api_key:
        async def _err():
            yield _sse(RunErrorEvent(message="No API key provided", code="NO_API_KEY"))
        return StreamingResponse(_err(), media_type="text/event-stream")

    # Configure LLM
    llm.LLM_CONFIG = LLMConfig(
        api_key=api_key,
        model=req.model or "mistral-small-latest",
        temperature=req.temperature if req.temperature is not None else 0.0,
        max_completion_tokens=req.max_tokens or 8000,
    )

    thread_id = body.thread_id
    run_id = body.run_id or _run_id()

    async def event_stream():
        yield _sse(RunStartedEvent(thread_id=thread_id, run_id=run_id))

        try:
            if req.scaffolded:
                async for ev in _stream_scaffolded(req, thread_id, run_id):
                    yield ev
            else:
                async for ev in _stream_zero_shot(req, thread_id, run_id):
                    yield ev

            yield _sse(RunFinishedEvent(thread_id=thread_id, run_id=run_id))
        except Exception as e:
            logger.exception("Traversal error")
            yield _sse(RunErrorEvent(message=str(e), code="TRAVERSAL_ERROR"))

    return StreamingResponse(event_stream(), media_type="text/event-stream")


async def _stream_scaffolded(
    req: TraversalRequest, thread_id: str, run_id: str
):
    """Run scaffolded traversal, yielding AG-UI events."""
    config = llm.LLM_CONFIG
    key = generate_traversal_cache_key(
        req.clinical_note, config.model, config.temperature
    )

    burr_app, cached = await build_traversal_app(
        context=req.clinical_note,
        partition_key=key,
        persist_cache=req.persist_cache,
    )

    if cached:
        final_state = burr_app.state
        yield _sse(StateSnapshotEvent(snapshot=_state_snapshot(final_state)))
        return

    # Register batch callback for real-time streaming
    events_queue: asyncio.Queue = asyncio.Queue()

    def batch_callback(**kwargs: Any) -> None:
        events_queue.put_nowait(kwargs)

    # Set the callback
    from agent import actions
    prev_cb = actions.BATCH_CALLBACK
    actions.BATCH_CALLBACK = batch_callback

    # Initial state snapshot
    yield _sse(StateSnapshotEvent(snapshot={"batch_data": {}, "final_nodes": []}))

    # Run traversal in a task
    run_task = asyncio.create_task(
        burr_app.arun(halt_after=["finish"], inputs={})
    )

    # Stream events as they come
    while not run_task.done():
        try:
            batch_info = await asyncio.wait_for(events_queue.get(), timeout=0.5)
        except asyncio.TimeoutError:
            continue

        batch_id = batch_info["batch_id"]
        yield _sse(StepStartedEvent(step_name=batch_id))
        yield _sse(StateSnapshotEvent(snapshot=batch_info))
        if batch_info.get("reasoning"):
            yield _sse(CustomEvent(
                name="reasoning",
                value={
                    "batch_id": batch_id,
                    "reasoning": batch_info["reasoning"],
                },
            ))
        yield _sse(StepFinishedEvent(step_name=batch_id))

    # Drain remaining events
    while not events_queue.empty():
        batch_info = events_queue.get_nowait()
        batch_id = batch_info["batch_id"]
        yield _sse(StepStartedEvent(step_name=batch_id))
        yield _sse(StateSnapshotEvent(snapshot=batch_info))
        yield _sse(StepFinishedEvent(step_name=batch_id))

    # Get final state
    _, _, final_state = run_task.result()
    yield _sse(StateSnapshotEvent(snapshot=_state_snapshot(final_state)))

    # Restore callback
    actions.BATCH_CALLBACK = prev_cb


async def _stream_zero_shot(
    req: TraversalRequest, thread_id: str, run_id: str
):
    """Run zero-shot traversal, yielding AG-UI events."""
    config = llm.LLM_CONFIG
    key = generate_traversal_cache_key(
        req.clinical_note, config.model, config.temperature
    )

    burr_app, cached = await build_zero_shot_app(
        clinical_note=req.clinical_note,
        partition_key=key,
        persist_cache=req.persist_cache,
    )

    if cached:
        final_state = burr_app.state
    else:
        _, _, final_state = await burr_app.arun(
            halt_after=["finish"], inputs={}
        )

    final_nodes = final_state.get("final_nodes", [])
    yield _sse(StateSnapshotEvent(snapshot={
        "final_nodes": final_nodes,
        "reasoning": final_state.get("reasoning", ""),
    }))


def _state_snapshot(state: Any) -> dict:
    """Extract serializable state snapshot."""
    return {
        "batch_data": state.get("batch_data", {}),
        "final_nodes": state.get("final_nodes", []),
    }


# ---------------------------------------------------------------------------
# POST /api/traverse/rewind
# ---------------------------------------------------------------------------


@app.post("/api/traverse/rewind")
async def traverse_rewind(body: RewindRequest) -> StreamingResponse:
    """Rewind to a specific node and re-traverse with optionally updated prompt."""
    api_key = body.api_key or os.getenv("MISTRAL_API_KEY", "")
    if not api_key:
        async def _err():
            yield _sse(RunErrorEvent(message="No API key provided", code="NO_API_KEY"))
        return StreamingResponse(_err(), media_type="text/event-stream")

    llm.LLM_CONFIG = LLMConfig(
        api_key=api_key,
        model=body.model or "mistral-small-latest",
        temperature=body.temperature if body.temperature is not None else 0.0,
        max_completion_tokens=body.max_tokens or 8000,
    )

    config = llm.LLM_CONFIG
    key = generate_traversal_cache_key(
        body.clinical_note, config.model, config.temperature
    )

    prompt_builder = None
    if body.instruction_template:
        pb = DefaultScaffoldedPrompt()
        pb.instruction_template = body.instruction_template
        prompt_builder = pb

    thread_id = uuid.uuid4().hex[:16]
    run_id = _run_id()

    async def event_stream():
        yield _sse(RunStartedEvent(thread_id=thread_id, run_id=run_id))

        try:
            final_state = await retry_node(
                batch_id=body.batch_id,
                clinical_note=body.clinical_note,
                partition_key=key,
                prompt_builder=prompt_builder,
            )
            yield _sse(StateSnapshotEvent(snapshot=_state_snapshot(final_state)))
            yield _sse(RunFinishedEvent(thread_id=thread_id, run_id=run_id))
        except Exception as e:
            logger.exception("Rewind error")
            yield _sse(RunErrorEvent(message=str(e), code="REWIND_ERROR"))

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------


@app.post("/api/cache/invalidate")
async def cache_invalidate() -> dict:
    """Clear the in-memory LLM cache."""
    from agent.llm import LLM_CACHE
    count = len(LLM_CACHE)
    LLM_CACHE.clear()
    return {"cleared": count}


@app.post("/api/cache/clear-all")
async def cache_clear_all() -> dict:
    """Clear all persisted state (both traversal and zero-shot)."""
    await cleanup_persister()
    await cleanup_zs_persister()
    from agent.llm import LLM_CACHE
    LLM_CACHE.clear()
    return {"status": "all caches cleared"}


# ---------------------------------------------------------------------------
# Serve built frontend (must be after all API routes)
# ---------------------------------------------------------------------------

_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
