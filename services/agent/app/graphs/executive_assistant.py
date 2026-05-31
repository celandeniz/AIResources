"""Dedicated graph: AI Executive Assistant — inbox triage + scheduling + routing."""
from __future__ import annotations

from .base import GraphState, compile_resource_graph


def role_prep(state: GraphState) -> GraphState:
    a = state["request"].activity
    body = (a.body or "").lower()
    urgency = "urgent" if any(w in body for w in ("urgent", "asap", "today", "immediately")) else "normal"
    scheduling = any(w in body for w in ("call", "meeting", "reschedule", "move", "schedule", "calendar"))
    hint = (
        f"Triage as {urgency}. "
        + ("This looks like a scheduling request — draft a concise confirmation and propose a calendar update. "
           if scheduling else "Draft a professional reply; route to a specialist resource if it is out of scope. ")
        + "You have no financial or commercial authority."
    )
    return {"role_hint": hint}


graph = compile_resource_graph(role_prep)
