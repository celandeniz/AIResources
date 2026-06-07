"""Shared LangGraph building blocks.

Each AI Resource gets its OWN compiled StateGraph (see the per-resource modules),
but they share these node factories. A resource's graph is:

    START → role_prep (resource-specific) → rag → reason → postprocess → END

The role_prep node is what makes each graph distinct: it injects a role-specific
`role_hint`, can pull extra context (BC company, ADO project, transcript framing),
and can pre-seed expectations. The reason node calls the per-resource provider.
"""
from __future__ import annotations

from typing import Any, Callable, TypedDict

from langgraph.graph import StateGraph, START, END

from ..llm.base import get_provider
from ..tools.registry import tool_catalog_text
from .. import rag as rag_pkg


class GraphState(TypedDict, total=False):
    request: Any          # AgentRunRequest
    role_hint: str
    rag_hits: list[dict[str, Any]]
    result: dict[str, Any]
    usage: dict[str, Any]


def rag_node(state: GraphState) -> GraphState:
    req = state["request"]
    tools = set(req.ai_resource.tools)
    hits: list[dict[str, Any]] = []
    # carry any hits the worker already attached
    for h in (req.context.rag_hits or []):
        hits.append(h.model_dump() if hasattr(h, "model_dump") else dict(h))
    if "rag_search" in tools and len(hits) == 0:
        query = (req.activity.subject or "") + " " + (req.activity.body or "")
        flt = {}
        if req.activity.customer:
            flt["customer_id"] = req.activity.customer.id
        if req.activity.project:
            flt["project_id"] = req.activity.project.id
        if req.workspace_id:
            flt["workspace_id"] = req.workspace_id
        try:
            hits = rag_pkg.search(query.strip(), top_k=4, filter=flt or None)
        except Exception:
            hits = []
    return {"rag_hits": hits}


def _build_user_prompt(state: GraphState) -> str:
    req = state["request"]
    a = req.activity
    lines = [
        "## ACTIVITY",
        f"channel: {a.channel}",
        f"subject: {a.subject or ''}",
        f"body:\n{a.body or ''}",
    ]
    if a.customer:
        lines.append(f"customer: {a.customer.name} (tier={a.customer.tier})")
    if a.project:
        lines.append(f"project: {a.project.name} (status={a.project.status})")
    if req.context.thread:
        lines.append("## THREAD")
        for m in req.context.thread:
            who = m.from_ or m.role
            lines.append(f"- [{m.role}] {who}: {m.text}")
    hits = state.get("rag_hits", [])
    if hits:
        lines.append("## RETRIEVED KNOWLEDGE (cite chunk_id you rely on)")
        for h in hits:
            lines.append(f"- ({h.get('chunk_id')}) {h.get('title') or ''}: {(h.get('text') or '')[:300]}")
    if state.get("role_hint"):
        lines.append("## ROLE FOCUS")
        lines.append(state["role_hint"])
    lines.append("## AVAILABLE TOOLS")
    lines.append(tool_catalog_text(req.ai_resource.tools))
    lines.append("\nReturn ONLY the AgentResult JSON object.")
    return "\n".join(lines)


def reason_node(state: GraphState) -> GraphState:
    req = state["request"]
    resource = req.ai_resource
    provider = get_provider(resource.provider, resource.model)

    if hasattr(provider, "synthesize"):
        # Stub path: structured, role-aware, deterministic (no creds configured).
        result, usage = provider.synthesize(state)  # type: ignore[attr-defined]
        return {"result": result, "usage": usage}

    system = resource.system_prompt
    user = _build_user_prompt(state)
    try:
        result, usage = provider.generate_json(system, user, resource.temperature)
        usage = {**usage, "provider": getattr(provider, "name", resource.provider), "model": resource.model}
        return {"result": result, "usage": usage}
    except Exception as e:
        # Primary provider errored (e.g. Gemini 503 on the free tier, or a cloud
        # timeout). Prefer a REAL local fallback (Ollama) over the deterministic
        # stub so quality degrades gracefully — Gemini quality when available,
        # a real local draft when it's not, stub only if local is also down.
        import os

        if resource.provider != "ollama":
            try:
                from ..llm.ollama_provider import OllamaProvider

                fb_model = os.getenv("OLLAMA_FALLBACK_MODEL", "qwen3")
                fb = OllamaProvider(fb_model)
                result, usage = fb.generate_json(system, user, resource.temperature)
                usage = {**usage, "provider": "ollama", "model": fb_model, "fallback_from": resource.provider, "error": str(e)[:200]}
                return {"result": result, "usage": usage}
            except Exception:
                pass  # local fallback also unavailable → stub below

        from ..llm.stub_provider import StubProvider

        result, usage = StubProvider(requested=resource.provider, model=resource.model).synthesize(state)
        usage = {**usage, "fallback": True, "error": str(e)[:200]}
        return {"result": result, "usage": usage}


def postprocess_node(state: GraphState) -> GraphState:
    req = state["request"]
    resource = req.ai_resource
    result = dict(state.get("result") or {})
    allowed = set(resource.tools)

    # clamp confidence
    try:
        conf = float(result.get("confidence", 0.5))
    except Exception:
        conf = 0.5
    conf = max(0.0, min(1.0, conf))
    result["confidence"] = conf

    # filter tool_intents to allowed tools (defense in depth)
    intents = [i for i in (result.get("tool_intents") or []) if i.get("tool") in allowed]
    result["tool_intents"] = intents

    # force escalation if below the resource threshold
    if conf < resource.confidence_threshold:
        result["needs_escalation"] = True

    # ensure required keys exist
    result.setdefault("draft", {"kind": "none", "content": "", "recipients": [], "citations": []})
    result.setdefault("reasoning_summary", "")
    result.setdefault("needs_escalation", False)
    result.setdefault("escalate_to", None)
    return {"result": result}


def compile_resource_graph(role_prep: Callable[[GraphState], GraphState]):
    """Build a dedicated compiled graph wired with this resource's role_prep node."""
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()
