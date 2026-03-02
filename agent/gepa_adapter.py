"""GEPA adapter for Medstral ICD-10-CM traversal optimization."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, TypedDict

from gepa.core.adapter import EvaluationBatch, GEPAAdapter

from agent import actions, llm
from agent.benchmark import compute_metrics
from agent.llm import LLMConfig
from agent.prompts import DefaultScaffoldedPrompt
from agent.traversal import build_traversal_app, generate_traversal_cache_key

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Type aliases for GEPA generics
# ---------------------------------------------------------------------------


class MedstralDataInst(TypedDict):
    clinical_note: str
    gold_codes: list[str]


class MedstralTrajectory(TypedDict):
    data: MedstralDataInst
    batch_data: dict[str, Any]
    final_nodes: list[str]


class MedstralRolloutOutput(TypedDict):
    final_codes: list[str]
    recall: float
    precision: float


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class MedstralAdapter(
    GEPAAdapter[MedstralDataInst, MedstralTrajectory, MedstralRolloutOutput]
):
    """Bridge between GEPA's optimisation loop and the Medstral traversal agent."""

    def __init__(self, llm_config: LLMConfig) -> None:
        self.llm_config = llm_config

    # -- public interface (called synchronously by GEPA engine) -------------

    def evaluate(
        self,
        batch: list[MedstralDataInst],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> EvaluationBatch[MedstralTrajectory, MedstralRolloutOutput]:
        """Run traversals for each example. Sync wrapper for GEPA's thread."""
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(
                self._async_evaluate(batch, candidate, capture_traces)
            )
        finally:
            loop.close()

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: EvaluationBatch[MedstralTrajectory, MedstralRolloutOutput],
        components_to_update: list[str],
    ) -> dict[str, list[dict[str, Any]]]:
        """Build per-component feedback for the reflection LM."""
        assert len(components_to_update) == 1
        comp = components_to_update[0]

        items: list[dict[str, Any]] = []
        trajectories = eval_batch.trajectories or []

        for traj, score, output in zip(
            trajectories, eval_batch.scores, eval_batch.outputs, strict=False
        ):
            data = traj["data"]
            batch_data = traj["batch_data"]
            final_nodes = traj["final_nodes"]
            metrics = compute_metrics(data["gold_codes"], final_nodes)

            # Summarise per-batch reasoning (truncated)
            reasoning_summary: dict[str, str] = {}
            for bid, bd in batch_data.items():
                selected = bd.get("selected_ids", [])
                reason = bd.get("reasoning", "")
                reasoning_summary[bid] = (
                    f"selected={selected} | {reason[:200]}"
                )

            if score >= 1.0:
                feedback = (
                    f"Correct! Traversal produced the expected codes "
                    f"{data['gold_codes']}."
                )
            else:
                parts: list[str] = []
                if metrics.missed:
                    parts.append(f"Missing codes: {metrics.missed}")
                if metrics.extra:
                    parts.append(f"Unexpected codes: {metrics.extra}")
                if metrics.undershoot:
                    parts.append(
                        f"Undershoot (ancestor selected instead of target): "
                        f"{metrics.undershoot}"
                    )
                if metrics.overshoot:
                    parts.append(
                        f"Overshoot (descendant selected instead of target): "
                        f"{metrics.overshoot}"
                    )
                feedback = " | ".join(parts) or "Incorrect result."

            items.append(
                {
                    "Inputs": (
                        f"Clinical note: {data['clinical_note'][:500]}\n"
                        f"Expected ICD-10-CM codes: {data['gold_codes']}"
                    ),
                    "Generated Outputs": (
                        f"Final codes: {final_nodes}\n"
                        f"Traversal reasoning:\n"
                        f"{json.dumps(reasoning_summary, indent=2)[:2000]}"
                    ),
                    "Feedback": feedback,
                }
            )

        return {comp: items}

    # -- private async evaluation -------------------------------------------

    async def _async_evaluate(
        self,
        batch: list[MedstralDataInst],
        candidate: dict[str, str],
        capture_traces: bool,
    ) -> EvaluationBatch[MedstralTrajectory, MedstralRolloutOutput]:
        outputs: list[MedstralRolloutOutput] = []
        scores: list[float] = []
        trajectories: list[MedstralTrajectory] | None = (
            [] if capture_traces else None
        )

        # Set global LLM config (we're in a dedicated thread)
        llm.LLM_CONFIG = self.llm_config
        prev_cb = actions.BATCH_CALLBACK
        actions.BATCH_CALLBACK = None  # disable streaming during eval

        try:
            for data in batch:
                pb = DefaultScaffoldedPrompt()
                pb.instruction_template = candidate.get(
                    "instruction_template", pb.instruction_template
                )

                # Unique partition key — no caching during GEPA evaluation
                base_key = generate_traversal_cache_key(
                    data["clinical_note"],
                    self.llm_config.model,
                    self.llm_config.temperature,
                )
                key = f"{base_key}_gepa_{uuid.uuid4().hex[:8]}"

                app, _ = await build_traversal_app(
                    context=data["clinical_note"],
                    partition_key=key,
                    prompt_builder=pb,
                    persist_cache=False,
                )
                _, _, final_state = await app.arun(
                    halt_after=["finish"], inputs={}
                )

                final_nodes: list[str] = final_state.get("final_nodes", [])
                bd: dict[str, Any] = dict(final_state.get("batch_data", {}))
                metrics = compute_metrics(data["gold_codes"], final_nodes)

                outputs.append(
                    {
                        "final_codes": final_nodes,
                        "recall": metrics.recall,
                        "precision": metrics.precision,
                    }
                )
                scores.append(metrics.recall)

                if capture_traces and trajectories is not None:
                    trajectories.append(
                        {
                            "data": data,
                            "batch_data": bd,
                            "final_nodes": final_nodes,
                        }
                    )
        finally:
            actions.BATCH_CALLBACK = prev_cb

        return EvaluationBatch(
            outputs=outputs,
            scores=scores,
            trajectories=trajectories,
        )
