"""Async wrapper for GEPA prompt optimization with progress streaming."""

from __future__ import annotations

import asyncio
import logging
import queue
import re
import threading
from typing import Any, Protocol

from gepa import optimize
from gepa.core.result import GEPAResult

from agent.gepa_adapter import MedstralAdapter
from agent.llm import LLMConfig
from agent.prompts import DefaultScaffoldedPrompt

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Callback protocol
# ---------------------------------------------------------------------------


class GepaProgressCallback(Protocol):
    def __call__(self, event_type: str, data: dict[str, Any]) -> None: ...


# ---------------------------------------------------------------------------
# Thread-safe logger for GEPA
# ---------------------------------------------------------------------------


class QueueLogger:
    """Captures GEPA log messages to a thread-safe queue."""

    def __init__(self, q: queue.Queue[tuple[str, Any]]) -> None:
        self._q = q

    def log(self, message: str) -> None:
        self._q.put(("log", message))


# ---------------------------------------------------------------------------
# Log message parsing
# ---------------------------------------------------------------------------

_RE_ITER = re.compile(r"Iteration\s+(\d+):")
_RE_SCORE = re.compile(r"score:\s*([\d.]+)")
_RE_PROPOSED = re.compile(
    r"Iteration\s+(\d+):\s*Proposed new text for (\S+):\s*(.*)", re.DOTALL
)
_RE_SELECTED = re.compile(r"Iteration\s+(\d+):\s*Selected program (\d+)")
_RE_NOT_BETTER = re.compile(r"New subsample score is not better")
_RE_PARETO = re.compile(r"New program is on the linear pareto front")
_RE_BASE_SCORE = re.compile(r"Base program full valset score:\s*([\d.]+)")
_RE_SKIPPING = re.compile(r"Skipping|skipping")


def _parse_log_message(
    message: str,
    callback: GepaProgressCallback | None,
) -> None:
    """Parse a GEPA log message and emit typed events via callback."""
    if callback is None:
        return

    # Always emit raw log
    iteration = 0
    m = _RE_ITER.search(message)
    if m:
        iteration = int(m.group(1))

    # Base score (iteration 1 log)
    m_base = _RE_BASE_SCORE.search(message)
    if m_base:
        callback(
            "gepa_base_score",
            {"iteration": 0, "score": float(m_base.group(1)), "message": message},
        )
        return

    # Proposed new text
    m_prop = _RE_PROPOSED.match(message)
    if m_prop:
        callback(
            "gepa_mutation",
            {
                "iteration": int(m_prop.group(1)),
                "component": m_prop.group(2),
                "new_text": m_prop.group(3).strip(),
                "message": message,
            },
        )
        return

    # Selected program
    m_sel = _RE_SELECTED.match(message)
    if m_sel:
        score_match = _RE_SCORE.search(message)
        callback(
            "gepa_iteration_start",
            {
                "iteration": int(m_sel.group(1)),
                "parent_id": int(m_sel.group(2)),
                "score": float(score_match.group(1)) if score_match else None,
                "message": message,
            },
        )
        return

    # Not better / skipping
    if _RE_NOT_BETTER.search(message) or _RE_SKIPPING.search(message):
        callback(
            "gepa_rejected",
            {"iteration": iteration, "message": message},
        )
        return

    # Pareto front
    if _RE_PARETO.search(message):
        callback(
            "gepa_accepted",
            {"iteration": iteration, "message": message},
        )
        return

    # Fallback: generic log
    callback("gepa_log", {"iteration": iteration, "message": message})


# ---------------------------------------------------------------------------
# Build result dict
# ---------------------------------------------------------------------------


def _build_result_dict(result: GEPAResult) -> dict[str, Any]:
    best_idx = result.best_idx
    return {
        "best_candidate": result.best_candidate,
        "best_score": result.val_aggregate_scores[best_idx],
        "candidates": [
            {"candidate": c, "score": s}
            for c, s in zip(result.candidates, result.val_aggregate_scores)
        ],
        "total_iterations": result.num_full_val_evals or len(result.candidates),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


async def run_gepa_optimize(
    clinical_note: str,
    gold_codes: list[str],
    llm_config: LLMConfig,
    num_iters: int = 3,
    callback: GepaProgressCallback | None = None,
) -> dict[str, Any]:
    """Run GEPA optimisation in a background thread, streaming progress.

    Returns a dict with best_candidate, best_score, candidates, total_iterations.
    """
    seed = {
        "instruction_template": DefaultScaffoldedPrompt().instruction_template,
    }
    trainset: list[dict[str, Any]] = [
        {"clinical_note": clinical_note, "gold_codes": gold_codes},
    ]
    adapter = MedstralAdapter(llm_config)

    # litellm model string for Mistral
    reflection_lm = f"mistral/{llm_config.model}"

    q: queue.Queue[tuple[str, Any]] = queue.Queue()
    error_holder: list[Exception] = []

    def _run() -> None:
        try:
            result = optimize(
                seed_candidate=seed,
                trainset=trainset,
                adapter=adapter,
                reflection_lm=reflection_lm,
                max_metric_calls=num_iters,
                logger=QueueLogger(q),
            )
            q.put(("done", result))
        except Exception as exc:
            logger.exception("GEPA optimization failed")
            error_holder.append(exc)
            q.put(("error", exc))

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    result_dict: dict[str, Any] | None = None

    while thread.is_alive() or not q.empty():
        try:
            msg_type, data = q.get(timeout=0.3)
        except queue.Empty:
            await asyncio.sleep(0.1)
            continue

        if msg_type == "log":
            _parse_log_message(data, callback)
        elif msg_type == "done":
            gepa_result: GEPAResult = data
            result_dict = _build_result_dict(gepa_result)
            if callback:
                callback("gepa_result", result_dict)
            break
        elif msg_type == "error":
            raise data

    thread.join(timeout=10)

    if result_dict is None:
        if error_holder:
            raise error_holder[0]
        raise RuntimeError("GEPA optimization completed without producing a result")

    return result_dict
