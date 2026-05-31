"""Tool catalog used to describe available tools in the prompt. Mirrors the
authoritative registry in packages/shared/tool-intents.ts. The agent only
DESCRIBES intents; Node executes them, so `sensitive` here is advisory."""
from __future__ import annotations

TOOLS: dict[str, dict] = {
    "send_email": {"sensitive": True, "desc": "Send an outbound email."},
    "send_teams_message": {"sensitive": True, "desc": "Post a Teams message."},
    "create_calendar_event": {"sensitive": True, "desc": "Create a calendar event."},
    "update_calendar_event": {"sensitive": True, "desc": "Reschedule/cancel a calendar event."},
    "create_task": {"sensitive": False, "desc": "Create an internal follow-up task."},
    "rag_search": {"sensitive": False, "desc": "Search the knowledge base (read-only)."},
    "devops_create_workitem": {"sensitive": True, "desc": "Create an Azure DevOps work item."},
    "devops_update_workitem": {"sensitive": True, "desc": "Update an Azure DevOps work item."},
    "devops_comment": {"sensitive": True, "desc": "Comment on an ADO work item."},
    "github_create_issue": {"sensitive": True, "desc": "Open a GitHub issue."},
    "github_comment": {"sensitive": True, "desc": "Comment on a GitHub issue/PR."},
    "github_review_pr": {"sensitive": True, "desc": "Post a GitHub PR review."},
    "opsconnect_create_project": {"sensitive": True, "desc": "Create an OpsConnect project."},
    "opsconnect_create_task": {"sensitive": True, "desc": "Create an OpsConnect task."},
    "opsconnect_update_status": {"sensitive": True, "desc": "Update OpsConnect status."},
    "opsconnect_comment": {"sensitive": True, "desc": "Comment on an OpsConnect item."},
    "bc_read_customer": {"sensitive": False, "desc": "Read a Business Central customer."},
    "bc_read_invoices": {"sensitive": False, "desc": "Read Business Central invoices."},
    "bc_read_balance": {"sensitive": False, "desc": "Read a customer balance."},
    "bc_create_invoice": {"sensitive": True, "desc": "Create a BC sales invoice (always approval)."},
    "bc_post_payment": {"sensitive": True, "desc": "Post a BC payment (always approval)."},
    "crm_read_record": {"sensitive": False, "desc": "Read a CRM record."},
    "crm_update_record": {"sensitive": True, "desc": "Create/update a CRM record."},
    "create_ticket": {"sensitive": False, "desc": "Open a support ticket."},
    "update_ticket": {"sensitive": False, "desc": "Update a support ticket."},
    "create_document": {"sensitive": False, "desc": "Save a draft document."},
    "generate_quote": {"sensitive": True, "desc": "Produce a priced quote."},
    "send_proposal": {"sensitive": True, "desc": "Deliver a proposal to a customer (always approval)."},
    "handoff": {"sensitive": False, "desc": "Route to another AI Resource."},
}


def tool_catalog_text(allowed: list[str]) -> str:
    lines = []
    for name in allowed:
        meta = TOOLS.get(name)
        if not meta:
            continue
        s = "sensitive" if meta["sensitive"] else "auto"
        lines.append(f"- {name} ({s}): {meta['desc']}")
    return "\n".join(lines) or "- (none)"
