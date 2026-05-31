"""Dedicated graph: AI HR / Admin Assistant — internal HR/admin requests."""
from __future__ import annotations

from .base import GraphState, compile_resource_graph


def role_prep(state: GraphState) -> GraphState:
    return {"role_hint": "Handle the internal HR/admin request (leave, onboarding, policy, scheduling) from policy. "
                         "Payroll/compensation and PII-sensitive decisions always escalate to a human manager."}


graph = compile_resource_graph(role_prep)
