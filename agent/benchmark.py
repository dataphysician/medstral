from __future__ import annotations

import logging
from dataclasses import dataclass, field

from agent.actions import get_index, get_node
from agent.llm import LLM_CONFIG, LLMConfig
from agent.prompts import PromptBuilder
from agent.traversal import build_traversal_app, generate_traversal_cache_key
from agent.zero_shot import build_zero_shot_app

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def normalize_icd(code: str) -> str:
    return code.replace(".", "").upper()


def lcp(a: str, b: str) -> str:
    """Longest common prefix."""
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return a[:i]


def build_gold_trajectory(gold_code: str) -> tuple[dict[str, str], int]:
    """Walk ICD-10 index upward from *gold_code* to ROOT.

    Returns ``(trajectory, max_depth)`` where *trajectory* maps
    depth strings (``"1"``, ``"2"``, ...) to the node-id at that depth.
    Raises ``KeyError`` if *gold_code* is not in the index.
    """
    idx = get_index()
    if gold_code not in idx:
        raise KeyError(f"Code {gold_code!r} not found in ICD-10-CM index")

    # Collect (depth, node_id) pairs walking upward
    chain: list[tuple[int, str]] = []
    current: str | None = gold_code
    while current and current in idx:
        node = idx[current]
        depth: int = node["depth"]
        chain.append((depth, current))
        parent_map = node.get("parent", {})
        current = next(iter(parent_map), None) if parent_map else None

    # Build trajectory keyed by depth string, excluding ROOT (depth 0)
    trajectory: dict[str, str] = {}
    max_depth = 0
    for d, nid in chain:
        if d > 0:
            trajectory[str(d)] = nid
            max_depth = max(max_depth, d)

    return trajectory, max_depth


def is_ancestor(candidate: str, target: str) -> bool:
    """True if candidate is a strict ancestor of target (prefix check)."""
    c, t = normalize_icd(candidate), normalize_icd(target)
    return t.startswith(c) and len(c) < len(t)


def is_descendant(candidate: str, target: str) -> bool:
    """True if candidate is a strict descendant of target."""
    return is_ancestor(target, candidate)


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


@dataclass
class CodeMetrics:
    expected: list[str] = field(default_factory=list)
    traversed: list[str] = field(default_factory=list)
    exact_matches: list[str] = field(default_factory=list)
    missed: list[str] = field(default_factory=list)
    extra: list[str] = field(default_factory=list)
    undershoot: list[tuple[str, str]] = field(default_factory=list)  # (traversed, expected)
    overshoot: list[tuple[str, str]] = field(default_factory=list)  # (traversed, expected)
    recall: float = 0.0
    precision: float = 0.0


def compute_metrics(
    expected_codes: list[str],
    traversed_codes: list[str],
) -> CodeMetrics:
    """Compare finalized codes against ground truth."""
    m = CodeMetrics(expected=expected_codes, traversed=traversed_codes)
    expected_set = set(expected_codes)
    traversed_set = set(traversed_codes)

    # Exact matches
    m.exact_matches = sorted(expected_set & traversed_set)

    # Missed (in expected but not traversed)
    potentially_missed = expected_set - traversed_set

    # Extra (in traversed but not expected)
    potentially_extra = traversed_set - expected_set

    # Classify: undershoot = traversed code is ancestor of an expected code
    #           overshoot  = traversed code is descendant of an expected code
    matched_expected: set[str] = set(m.exact_matches)
    matched_traversed: set[str] = set(m.exact_matches)

    for tc in potentially_extra:
        for ec in potentially_missed:
            if is_ancestor(tc, ec):
                m.undershoot.append((tc, ec))
                matched_expected.add(ec)
                matched_traversed.add(tc)
            elif is_descendant(tc, ec):
                m.overshoot.append((tc, ec))
                matched_expected.add(ec)
                matched_traversed.add(tc)

    m.missed = sorted(expected_set - matched_expected)
    m.extra = sorted(traversed_set - matched_traversed)

    # Recall and precision
    if expected_codes:
        m.recall = len(matched_expected) / len(expected_set)
    if traversed_codes:
        m.precision = len(matched_traversed) / len(traversed_set)

    return m


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------


async def run_benchmark(
    clinical_note: str,
    expected_codes: list[str],
    scaffolded: bool = True,
    prompt_builder: PromptBuilder | None = None,
) -> tuple[CodeMetrics, CodeMetrics]:
    """Run traversal and compare against ground truth.

    Returns (code_metrics, path_metrics).
    - code_metrics: compares final codes only
    - path_metrics: compares all traversed node IDs
    """
    config = LLM_CONFIG
    if config is None:
        raise RuntimeError("LLM_CONFIG not set")

    key = generate_traversal_cache_key(
        clinical_note, config.model, config.temperature
    )

    if scaffolded:
        app, cached = await build_traversal_app(
            context=clinical_note,
            partition_key=key,
            prompt_builder=prompt_builder,
        )
        if not cached:
            _, _, final_state = await app.arun(
                halt_after=["finish"], inputs={}
            )
        else:
            final_state = app.state
    else:
        app, cached = await build_zero_shot_app(
            clinical_note=clinical_note,
            partition_key=key,
            prompt_builder=prompt_builder,
        )
        if not cached:
            _, _, final_state = await app.arun(
                halt_after=["zs_finish"], inputs={}
            )
        else:
            final_state = app.state

    final_nodes: list[str] = final_state.get("final_nodes", [])
    batch_data: dict = final_state.get("batch_data", {})

    # Code-level metrics
    code_metrics = compute_metrics(expected_codes, final_nodes)

    # Path-level metrics: all node_ids that were traversed (all batch entries)
    all_traversed_nodes = [
        bd.get("node_id", "")
        for bd in batch_data.values()
        if bd.get("node_id")
    ]
    path_metrics = compute_metrics(expected_codes, all_traversed_nodes)

    logger.info(
        "Benchmark: recall=%.2f precision=%.2f exact=%d missed=%d extra=%d "
        "undershoot=%d overshoot=%d",
        code_metrics.recall,
        code_metrics.precision,
        len(code_metrics.exact_matches),
        len(code_metrics.missed),
        len(code_metrics.extra),
        len(code_metrics.undershoot),
        len(code_metrics.overshoot),
    )

    return code_metrics, path_metrics
