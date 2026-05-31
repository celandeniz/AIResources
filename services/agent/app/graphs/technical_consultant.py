"""Dedicated graph: AI Technical Consultant — adds an ADO/GitHub framing node.

Wiring:  START → role_prep → devops_context → rag → reason → postprocess → END
"""
from __future__ import annotations

from langgraph.graph import StateGraph, START, END

from .base import GraphState, rag_node, reason_node, postprocess_node


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Analyze the technical issue (plugins, Power Platform, integrations, deployments). "
                         "Draft a fix plan. Never change production directly — propose tracked work items only."}


def devops_context(state: GraphState) -> GraphState:
    body = (state["request"].activity.body or "").lower()
    hint = state.get("role_hint", "")
    if any(w in body for w in ("github", "pull request", " pr ", "repo", "commit")):
        hint += " This concerns source control — prefer a GitHub issue/PR review."
    else:
        hint += " Prefer an Azure DevOps work item to track the change."
    return {"role_hint": hint}


def build():
    g = StateGraph(GraphState)
    g.add_node("role_prep", role_prep)
    g.add_node("devops_context", devops_context)
    g.add_node("rag", rag_node)
    g.add_node("reason", reason_node)
    g.add_node("postprocess", postprocess_node)
    g.add_edge(START, "role_prep")
    g.add_edge("role_prep", "devops_context")
    g.add_edge("devops_context", "rag")
    g.add_edge("rag", "reason")
    g.add_edge("reason", "postprocess")
    g.add_edge("postprocess", END)
    return g.compile()


graph = build()
