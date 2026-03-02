from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field

import httpx
from pydantic import BaseModel

try:
    from weave import op as weave_op
except ImportError:

    def weave_op(name: str = ""):  # type: ignore[assignment]
        def _passthrough(fn):  # type: ignore[no-untyped-def]
            return fn

        return _passthrough

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass
class LLMConfig:
    api_key: str
    base_url: str = "https://api.mistral.ai/v1"
    model: str = "mistral-small-latest"
    temperature: float = 0.0
    max_completion_tokens: int = 8000
    timeout: float = 180.0

    def settings_hash(self) -> str:
        blob = f"{self.model}:{self.temperature}:{self.max_completion_tokens}"
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Structured output schema
# ---------------------------------------------------------------------------


class CodeSelectionResult(BaseModel):
    reasoning: str
    selected_codes: list[str]


_JSON_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "CodeSelectionResult",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "reasoning": {"type": "string"},
                "selected_codes": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": ["reasoning", "selected_codes"],
            "additionalProperties": False,
        },
    },
}

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

LLM_CONFIG: LLMConfig | None = None
LLM_CACHE: dict[str, tuple[list[str], str]] = {}


def _cache_key(messages: list[dict[str, str]], config: LLMConfig) -> str:
    blob = json.dumps(messages, sort_keys=True) + config.settings_hash()
    return hashlib.sha256(blob.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Core LLM call
# ---------------------------------------------------------------------------


@weave_op(name="call_llm")
async def call_llm(
    messages: list[dict[str, str]],
    config: LLMConfig,
) -> tuple[list[str], str]:
    """POST to OpenAI-compatible /chat/completions with json_schema response_format.

    Returns (selected_codes, reasoning).
    """
    key = _cache_key(messages, config)
    if key in LLM_CACHE:
        logger.debug("LLM cache hit for %s", key[:12])
        return LLM_CACHE[key]

    payload = {
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_completion_tokens,
        "response_format": _JSON_SCHEMA,
    }

    async with httpx.AsyncClient(
        base_url=config.base_url,
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        },
        timeout=config.timeout,
    ) as client:
        resp = await client.post("/chat/completions", json=payload)
        resp.raise_for_status()

    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    parsed = CodeSelectionResult.model_validate_json(content)

    result = (parsed.selected_codes, parsed.reasoning)
    LLM_CACHE[key] = result
    logger.info(
        "LLM returned %d codes for cache key %s",
        len(parsed.selected_codes),
        key[:12],
    )
    return result
