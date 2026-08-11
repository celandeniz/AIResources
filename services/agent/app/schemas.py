"""Pydantic models mirroring the hybrid seam contract (packages/shared/agent.ts)."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


class CustomerCtx(BaseModel):
    id: str
    name: str
    tier: Optional[str] = None


class ProjectCtx(BaseModel):
    id: str
    name: str
    status: Optional[str] = None


class ActivityCtx(BaseModel):
    id: str
    channel: str
    subject: Optional[str] = None
    body: Optional[str] = None
    priority: Optional[str] = None
    customer: Optional[CustomerCtx] = None
    project: Optional[ProjectCtx] = None
    received_at: Optional[str] = None


class ThreadMsg(BaseModel):
    role: str
    from_: Optional[str] = Field(default=None, alias="from")
    at: Optional[str] = None
    text: str

    class Config:
        populate_by_name = True


class RagHit(BaseModel):
    chunk_id: Optional[str] = None
    document_id: Optional[str] = None
    title: Optional[str] = None
    score: Optional[float] = None
    text: Optional[str] = None


class RunContext(BaseModel):
    thread: list[ThreadMsg] = []
    rag_hints: list[str] = []
    rag_hits: list[RagHit] = []
    user_timezone: Optional[str] = None


class AiResourceCfg(BaseModel):
    key: str
    name: str
    system_prompt: str
    provider: str
    model: str
    temperature: float = 0.2
    tools: list[str] = []
    confidence_threshold: float = 0.75


class AgentRunRequest(BaseModel):
    run_id: str
    workspace_id: Optional[str] = None
    ai_resource: AiResourceCfg
    activity: ActivityCtx
    context: RunContext = RunContext()
    options: dict[str, Any] = {}
    images: Optional[list[str]] = None


class Draft(BaseModel):
    kind: str = "none"
    subject: Optional[str] = None
    content: str = ""
    recipients: list[str] = []
    citations: list[str] = []


class ToolIntent(BaseModel):
    tool: str
    sensitive: bool = False
    args: dict[str, Any] = {}
    rationale: Optional[str] = None
    idempotency_key: Optional[str] = None
    target_integration_id: Optional[str] = None


class AgentResult(BaseModel):
    draft: Draft = Draft()
    reasoning_summary: str = ""
    confidence: float = 0.5
    needs_escalation: bool = False
    escalate_to: Optional[str] = None
    tool_intents: list[ToolIntent] = []


class AgentRunResponse(AgentResult):
    run_id: str
    provider: Optional[str] = None
    model: Optional[str] = None
    token_usage: dict[str, Any] = {}
    latency_ms: Optional[int] = None


class RagIngestRequest(BaseModel):
    document_id: str
    title: str
    text: str
    metadata: dict[str, Any] = {}


class RagSearchRequest(BaseModel):
    query: str
    top_k: int = 5
    filter: Optional[dict[str, Any]] = None
