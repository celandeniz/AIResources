"""Dedicated graph: AI Proposal Manager — adds a pricing-context node.

Wiring:  START → role_prep → pricing_context → rag → reason → postprocess → END
"""
from __future__ import annotations

from langgraph.graph import StateGraph, START, END

from .base import GraphState, rag_node, reason_node, postprocess_node


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Assemble a proposal/SOW draft from templates and the rate catalog. "
                          "Compute indicative effort and pricing, but never send to the customer without approval."}


def pricing_context(state: GraphState) -> GraphState:
    # Resource-specific node: annotate the catalog framing the model should use.
    hint = state.get("role_hint", "")
    return {"role_hint": hint + " Use the standard DynamicsOps rate card (Sr Consultant 1200/day, "
                                "Consultant 900/day) and a 10% contingency. Flag any contract value over the approval limit."}


def build():
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("pricing_context", pricing_context)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "pricing_context")
    g.add_edge("pricing_context", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()


graph = build()
