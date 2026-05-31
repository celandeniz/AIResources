"""Dedicated graph: AI Project Manager — adds an action-item extraction node.

Wiring:  START → role_prep → extract_actions → rag → reason → postprocess → END
"""
from __future__ import annotations

import re

from langgraph.graph import StateGraph, START, END

from .base import GraphState, rag_node, reason_node, postprocess_node


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Keep the project on track: extract decisions and action items, create ADO work items "
                         "and tasks, and draft a status note. Do not change baselined plans/budgets without approval."}


def extract_actions(state: GraphState) -> GraphState:
    # Resource-specific node: pull candidate action items from the body/transcript.
    body = state["request"].activity.body or ""
    bullets = re.findall(r"(?:^|\n)\s*(?:[-*\d.]+)\s*(.+)", body)
    actions = [b.strip() for b in bullets][:8]
    hint = state.get("role_hint", "")
    if actions:
        hint += " Candidate action items detected: " + "; ".join(actions)
    return {"role_hint": hint}


def build():
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("extract_actions", extract_actions)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "extract_actions")
    g.add_edge("extract_actions", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()


graph = build()
