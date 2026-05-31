"""Maps each AI Resource key to its dedicated compiled LangGraph graph."""
from __future__ import annotations

from .graphs import (
    executive_assistant,
    sales_assistant,
    proposal_manager,
    project_manager,
    functional_consultant,
    technical_consultant,
    support_agent,
    finance_assistant,
    hr_admin_assistant,
    knowledge_manager,
    generic,
)

GRAPHS = {
    "ai_executive_assistant": executive_assistant.graph,
    "ai_sales_assistant": sales_assistant.graph,
    "ai_proposal_manager": proposal_manager.graph,
    "ai_project_manager": project_manager.graph,
    "ai_functional_consultant": functional_consultant.graph,
    "ai_technical_consultant": technical_consultant.graph,
    "ai_support_agent": support_agent.graph,
    "ai_finance_assistant": finance_assistant.graph,
    "ai_hr_admin_assistant": hr_admin_assistant.graph,
    "ai_knowledge_manager": knowledge_manager.graph,
}


def get_graph(resource_key: str):
    # Fall back to a neutral role-driven graph for resources without a bespoke graph.
    return GRAPHS.get(resource_key, generic.graph)
