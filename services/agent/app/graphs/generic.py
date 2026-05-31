"""Neutral skill-driven graph for seeded resources without a bespoke graph."""
from __future__ import annotations

from .base import compile_resource_graph, GraphState


def role_prep(state: GraphState) -> GraphState:
    req = state["request"]
    return {
        "role_hint": (
            f"Apply your role's senior expertise as {req.ai_resource.name}; "
            "put the client-ready deliverable in draft.content"
        )
    }


graph = compile_resource_graph(role_prep)
