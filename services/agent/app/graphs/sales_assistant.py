"""Dedicated graph: AI Sales Assistant — lead qualification + CRM hygiene."""
from __future__ import annotations

from .base import GraphState, compile_resource_graph


def role_prep(state: GraphState) -> GraphState:
    a = state["request"].activity
    body = (a.body or "").lower()
    is_rfp = any(w in body for w in ("proposal", "quote", "rfp", "sow", "pricing"))
    hint = (
        "Qualify the lead and keep CRM up to date. "
        + ("This is a formal proposal/quote request — qualify, then hand off to AI Proposal Manager; do not commit pricing. "
           if is_rfp else "Answer pre-sales questions and draft a follow-up. ")
        + "Escalate custom pricing/discounts and enterprise accounts."
    )
    return {"role_hint": hint}


graph = compile_resource_graph(role_prep)
