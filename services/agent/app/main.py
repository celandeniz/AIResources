"""DynamicsOps AI Resource Platform — agent service (FastAPI).

PURE reasoning + RAG. Holds no integration credentials and no DB driver. It only
PROPOSES tool_intents; the Node worker/api executes them behind the approval gate.
"""
from __future__ import annotations

import os
import time

from fastapi import FastAPI, Header, HTTPException

from .schemas import AgentRunRequest, AgentRunResponse, RagIngestRequest, RagSearchRequest
from .registry import get_graph
from . import rag as rag_pkg

app = FastAPI(title="DynamicsOps Agent Service", version="0.1.0")

INTERNAL_TOKEN = os.getenv("INTERNAL_TOKEN", "dev-internal-token")


def _check_internal(token: str | None):
    # Internal-only service. The worker/api pass X-Internal-Token.
    if token != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "agent", "graphs": 10, "fallback": "generic"}


@app.post("/v1/agents/run", response_model=AgentRunResponse)
def run_agent(req: AgentRunRequest, x_internal_token: str | None = Header(default=None)):
    _check_internal(x_internal_token)
    graph = get_graph(req.ai_resource.key)
    started = time.time()
    state = graph.invoke({"request": req})
    latency_ms = int((time.time() - started) * 1000)
    result = state.get("result") or {}
    usage = state.get("usage") or {}
    return AgentRunResponse(
        run_id=req.run_id,
        draft=result.get("draft", {}),
        reasoning_summary=result.get("reasoning_summary", ""),
        confidence=result.get("confidence", 0.5),
        needs_escalation=result.get("needs_escalation", False),
        escalate_to=result.get("escalate_to"),
        tool_intents=result.get("tool_intents", []),
        provider=req.ai_resource.provider,
        model=req.ai_resource.model,
        token_usage=usage,
        latency_ms=latency_ms,
    )


@app.post("/v1/rag/ingest")
def rag_ingest(req: RagIngestRequest, x_internal_token: str | None = Header(default=None)):
    _check_internal(x_internal_token)
    return rag_pkg.ingest(req.document_id, req.title, req.text, req.metadata)


@app.post("/v1/rag/search")
def rag_search(req: RagSearchRequest, x_internal_token: str | None = Header(default=None)):
    _check_internal(x_internal_token)
    return {"results": rag_pkg.search(req.query, top_k=req.top_k, filter=req.filter)}
