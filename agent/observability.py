"""Weights & Biases Weave integration for traversal observability."""
from __future__ import annotations

import logging
import os
from typing import Any, Callable

logger = logging.getLogger(__name__)

_WEAVE_ENABLED = False

try:
    import weave

    @weave.op(name="batch_decision")
    def trace_batch(
        *,
        batch_id: str,
        node_id: str,
        parent_id: str | None,
        depth: int,
        candidates: dict[str, str],
        selected_ids: list[str],
        reasoning: str,
        seven_chr_authority: dict[str, str] | None = None,
        prompt_messages: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Log a single batch decision as a Weave span."""
        return {
            "batch_id": batch_id,
            "node_id": node_id,
            "parent_id": parent_id,
            "depth": depth,
            "candidates_count": len(candidates),
            "selected_ids": selected_ids,
            "reasoning": reasoning,
        }

except ImportError:
    weave = None  # type: ignore[assignment]

    def trace_batch(**kwargs: Any) -> dict[str, Any]:  # type: ignore[misc]
        return {}


def init_weave() -> None:
    """Initialize Weave tracing if WANDB_API_KEY is set. No-ops otherwise."""
    global _WEAVE_ENABLED

    if weave is None:
        logger.debug("weave package not installed — skipping init")
        return

    api_key = os.getenv("WANDB_API_KEY", "")
    if not api_key:
        logger.info("WANDB_API_KEY not set — Weave tracing disabled")
        return

    project = os.getenv("WANDB_PROJECT", "medstral")
    weave.init(project)
    _WEAVE_ENABLED = True
    logger.info("Weave tracing enabled (project=%s)", project)


def make_weave_callback(
    inner: Callable[..., Any] | None = None,
) -> Callable[..., Any]:
    """Return a callback that logs to Weave then forwards to *inner*."""

    def _callback(**kwargs: Any) -> None:
        if _WEAVE_ENABLED:
            trace_batch(**kwargs)
        if inner is not None:
            inner(**kwargs)

    return _callback
