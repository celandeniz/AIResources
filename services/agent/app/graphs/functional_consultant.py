"""Dedicated graph: AI Functional Consultant — D365 requirements & user stories."""
from __future__ import annotations

from .base import GraphState, compile_resource_graph


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Map the requirement to Dynamics 365 modules (Sales, Customer Service, F&O). "
                         "Draft user stories with acceptance criteria and test scenarios, grounded in retrieved knowledge. "
                         "Hand off customizations to AI Technical Consultant."}


graph = compile_resource_graph(role_prep)
