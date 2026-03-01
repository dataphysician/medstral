from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class PromptBuilder(Protocol):
    instruction_template: str
    context_template: str

    def build_messages(
        self,
        context: str,
        batch_id: str,
        candidates: dict[str, str],
    ) -> list[dict[str, str]]: ...


# ---------------------------------------------------------------------------
# Default implementations
# ---------------------------------------------------------------------------

_SCAFFOLDED_INSTRUCTION = """\
You are an expert ICD-10-CM medical coding assistant. Select the most
clinically relevant codes from the candidates provided.

Rules:
1. Select 0 to N codes that are clinically relevant
2. Consider the candidate relationship type
3. Return reasoning first, then selected codes"""

_SCAFFOLDED_CONTEXT = """\
CURRENT CODE: {node_id}
CANDIDATE RELATIONSHIP: {relationship}

AVAILABLE CANDIDATES:
{candidates}"""

_ZERO_SHOT_INSTRUCTION = """\
You are an expert ICD-10-CM medical coding assistant. Analyze the clinical
note and generate the most appropriate ICD-10-CM codes.

Return reasoning first, then a list of specific ICD-10-CM codes."""


class DefaultScaffoldedPrompt:
    def __init__(self) -> None:
        self.instruction_template: str = _SCAFFOLDED_INSTRUCTION
        self.context_template: str = _SCAFFOLDED_CONTEXT

    def build_messages(
        self,
        context: str,
        batch_id: str,
        candidates: dict[str, str],
    ) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = [
            {"role": "system", "content": f"CLINICAL NOTE:\n{context}"},
            {"role": "user", "content": self.instruction_template},
        ]

        if candidates:
            formatted_candidates = "\n".join(
                f"{k} - {v}" for k, v in candidates.items()
            )

            if "|" in batch_id:
                node_id, relationship = batch_id.rsplit("|", 1)
            else:
                node_id, relationship = batch_id, "children"

            batch_content = self.context_template.format(
                batch_id=batch_id,
                node_id=node_id,
                relationship=relationship,
                candidates=formatted_candidates,
            )
            messages.append({"role": "user", "content": batch_content})

        return messages


class DefaultZeroShotPrompt:
    def __init__(self) -> None:
        self.instruction_template: str = _ZERO_SHOT_INSTRUCTION
        self.context_template: str = ""

    def build_messages(
        self,
        context: str,
        batch_id: str,
        candidates: dict[str, str],
    ) -> list[dict[str, str]]:
        return [
            {"role": "system", "content": f"CLINICAL NOTE:\n{context}"},
            {"role": "user", "content": self.instruction_template},
        ]
