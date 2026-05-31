"""Dedicated graph: AI Support Agent — adds a severity-classification node.

Wiring:  START → role_prep → classify_severity → rag → reason → postprocess → END
"""
from __future__ import annotations

from langgraph.graph import StateGraph, START, END

from .base import GraphState, rag_node, reason_node, postprocess_node


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Triage the support request, ground the solution in the knowledge base, open/update a ticket, "
                         "and draft a customer reply. Escalate suspected defects to AI Technical Consultant."}


def classify_severity(state: GraphState) -> GraphState:
    body = (state["request"].activity.body or "").lower()
    if any(w in body for w in ("down", "outage", "production", "data loss", "critical", "urgent")):
        sev = "critical"
    elif any(w in body for w in ("error", "fails", "cannot", "broken")):
        sev = "high"
    else:
        sev = "medium"
    hint = state.get("role_hint", "") + f" Assessed severity: {sev}. Set ticket priority accordingly."
    return {"role_hint": hint}


def build():
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("classify_severity", classify_severity)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "classify_severity")
    g.add_edge("classify_severity", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()


graph = build()
