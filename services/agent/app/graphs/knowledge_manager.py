"""Dedicated graph: AI Knowledge Manager — adds a citation-check node after reasoning.

Wiring:  START → role_prep → rag → reason → citation_check → postprocess → END
"""
from __future__ import annotations

from langgraph.graph import StateGraph, START, END

from .base import GraphState, rag_node, reason_node, postprocess_node


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Answer the internal knowledge query STRICTLY from retrieved knowledge, with citations. "
                         "Never fabricate citations; flag stale or missing sources."}


def citation_check(state: GraphState) -> GraphState:
    # Resource-specific node: if the draft cites nothing and no hits exist, force escalation / lower confidence.
    result = dict(state.get("result") or {})
    hits = state.get("rag_hits", [])
    citations = (result.get("draft") or {}).get("citations") or []
    if not hits and not citations:
        result["needs_escalation"] = True
        result["confidence"] = min(float(result.get("confidence", 0.5)), 0.5)
        result["reasoning_summary"] = (result.get("reasoning_summary", "") + " No grounding sources found — escalating for human review.").strip()
    return {"result": result}


def build():
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("citation_check", citation_check)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "citation_check")
    g.add_edge("citation_check", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()


graph = build()
