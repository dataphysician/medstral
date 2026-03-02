from __future__ import annotations

from pydantic import BaseModel


class TraversalRequest(BaseModel):
    clinical_note: str
    api_key: str = ""
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    system_prompt: str | None = None
    scaffolded: bool = True
    persist_cache: bool = True


class RewindRequest(BaseModel):
    batch_id: str
    clinical_note: str
    api_key: str = ""
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    instruction_template: str | None = None
    persist_cache: bool = True


class GoldTrajectoryRequest(BaseModel):
    gold_code: str


class GoldTrajectoryResponse(BaseModel):
    gold_code: str
    trajectory: dict[str, str]
    max_depth: int


class OptimizeRequest(BaseModel):
    batch_id: str
    clinical_note: str
    gold_code: str
    feedback: str = ""
    api_key: str = ""
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    persist_cache: bool = True


class GepaOptimizeRequest(BaseModel):
    clinical_note: str
    gold_codes: list[str]
    num_iters: int = 3
    api_key: str = ""
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
