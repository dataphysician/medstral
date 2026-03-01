from __future__ import annotations

from typing import TypedDict


class BatchData(TypedDict, total=False):
    node_id: str
    batch_type: str  # "children"|"codeFirst"|"codeAlso"|"useAdditionalCode"|"sevenChrDef"
    parent_id: str | None
    depth: int
    candidates: dict[str, str]  # {code: label}
    selected_ids: list[str]
    reasoning: str
    seven_chr_authority: dict[str, str] | None  # inherited sevenChrDef from ancestor
    prompt_messages: list[dict[str, str]]  # [{role, content}, ...] sent to LLM
