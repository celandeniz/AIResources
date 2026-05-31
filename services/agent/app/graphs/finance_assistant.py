"""Dedicated graph: AI Finance Assistant — adds a Business Central company-context node.

Wiring:  START → role_prep → bc_context → rag → reason → postprocess → END
"""
from __future__ import annotations

from langgraph.graph import StateGraph, START, END

from .base import GraphState, rag_node, reason_node, postprocess_node

BC_COMPANIES = ["Dynamics Ops Bilgi Tek Ltd Sti", "Dynamics Ops"]


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Handle the finance request: read Business Central, draft balances/reminders. "
                         "Invoice/payment actions are sensitive — always approval, and bounded by the approval limit."}


def bc_context(state: GraphState) -> GraphState:
    # Resource-specific node: pick the BC company by hint, default to Co.1.
    text = ((state["request"].activity.subject or "") + " " + (state["request"].activity.body or "")).lower()
    company = BC_COMPANIES[1] if "dynamics ops" in text and "bilgi" not in text else BC_COMPANIES[0]
    hint = state.get("role_hint", "") + f" Target Business Central company: \"{company}\" (tenant Production)."
    return {"role_hint": hint}


def build():
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("bc_context", bc_context)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "bc_context")
    g.add_edge("bc_context", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()


graph = build()
