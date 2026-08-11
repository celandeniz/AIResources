"""Deterministic, credential-free provider.

Produces role-appropriate AgentResult-shaped output so the whole platform — all
10 dedicated graphs — runs end-to-end with zero API keys. When a real key is
present the factory uses the real provider instead.
"""
from __future__ import annotations

import re
from typing import Any


class StubProvider:
    name = "stub"

    def __init__(self, requested: str = "stub", model: str = "stub"):
        self.requested = requested
        self.model = model

    # Generic text path (used only if a graph calls generate_json directly).
    def generate_json(
        self,
        system: str,
        user: str,
        temperature: float,
        images: list[str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return (
            {
                "draft": {"kind": "note", "content": "Stub reasoning (no LLM key configured).", "recipients": [], "citations": []},
                "reasoning_summary": "Stub provider active; set ANTHROPIC_API_KEY or AZURE_OPENAI_API_KEY for real drafts.",
                "confidence": 0.6,
                "needs_escalation": False,
                "tool_intents": [],
            },
            {"input": 0, "output": 0, "stub": True},
        )

    # Structured, role-aware synthesis used by the graphs (preferred path).
    def synthesize(self, state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        req = state["request"]
        resource = req.ai_resource
        activity = req.activity
        tools = set(resource.tools)
        key = resource.key
        subject = activity.subject or "(no subject)"
        body = (activity.body or "").strip()
        cust = activity.customer.name if activity.customer else "the customer"
        rag_hits = state.get("rag_hits", [])
        citations = [h.get("chunk_id") for h in rag_hits if h.get("chunk_id")][:3]
        role_hint = state.get("role_hint", "")

        intents: list[dict[str, Any]] = []
        draft_kind = "note"
        draft_subject = None
        draft_content = ""
        recipients: list[str] = []
        confidence = 0.82
        escalate = False
        escalate_to = None
        reasoning = ""

        sender = None
        if req.context and req.context.thread:
            sender = req.context.thread[0].from_
        sender = sender or "client@" + ((activity.customer.name if activity.customer else "customer").lower().replace(" ", "") + ".com")

        # ── Peer-review branch (2a): triggered when reviewer is asked to critique a draft
        if "REVIEW THE FOLLOWING DRAFT" in body:
            # Approve non-trivial drafts (body > 200 chars past the instruction preamble)
            # The body contains the DRAFT section after the preamble (~150 chars).
            draft_section = body.split("DRAFT:", 1)[-1].strip() if "DRAFT:" in body else ""
            is_trivial = len(draft_section) <= 200
            verdict_word = "revise" if is_trivial else "approve"
            review_confidence = 0.55 if is_trivial else 0.8
            critique = (
                f"- The draft addresses the main subject adequately.\n"
                f"- Tone is professional and aligned with DynamicsOps standards.\n"
                f"- {('Recommend expanding with specific customer context.' if is_trivial else 'No major structural issues found.')}\n"
                f"Verdict: {verdict_word}."
            )
            return (
                {
                    "draft": {
                        "kind": "note",
                        "subject": None,
                        "content": critique,
                        "recipients": [],
                        "citations": [],
                    },
                    "reasoning_summary": f"Peer review complete. Verdict: {verdict_word}. Quality score: {review_confidence}.",
                    "confidence": review_confidence,
                    "needs_escalation": False,
                    "escalate_to": None,
                    "tool_intents": [],
                },
                {"input": 0, "output": 0, "stub": True, "requested_provider": self.requested, "review": True},
            )

        # ── Proactive automation runs: emit deliverable + create tasks + hand
        #    off to partner departments so the org self-coordinates even with
        #    zero LLM keys. Triggered by the proactive activity body. ─────────
        if "PROACTIVE OBJECTIVE" in body:
            role = getattr(resource, "name", key.replace("_", " "))
            m = re.search(r"\(e\.g\.\s*(.+?)\)", body)
            tasks = [t.strip() for t in re.split(r";", m.group(1))] if m else []
            tasks = [t for t in tasks if t][:4] or [f"Advance: {subject}"]
            seen: set[str] = set()
            targets = [k for k in re.findall(r"\(([a-z_]+)\)", body)
                       if k.startswith("ai_") and not (k in seen or seen.add(k))][:5]
            obj_line = next(
                (ln.strip() for ln in body.splitlines()
                 if ln.strip() and "PROACTIVE OBJECTIVE" not in ln
                 and not ln.startswith("Today is") and not ln.strip().startswith("-")
                 and not ln.startswith("Use the resource")),
                subject,
            )
            pintents: list[dict[str, Any]] = []
            content_run = bool(re.search(r"\b(social content|social post|product launch|announcement)\b", f"{subject}\n{body}", re.I))
            if content_run and "create_document" in tools:
                for t in tasks[:5]:
                    pintents.append({"tool": "create_document", "sensitive": False,
                                     "args": {"title": t[:180], "kind": "social_post" if "social" in subject.lower() else "product_announcement", "content": f"Draft artifact for: {t}"},
                                     "rationale": "Persist draft content artifact."})
            if "create_task" in tools:
                for t in tasks:
                    pintents.append({"tool": "create_task", "sensitive": False,
                                     "args": {"title": t[:280], "proactive": True},
                                     "rationale": "Proactive next action."})
            if "handoff" in tools:
                for k in targets:
                    pintents.append({"tool": "handoff", "sensitive": False,
                                     "args": {"to": k, "subject": f"{subject} — input needed", "note": obj_line[:480]},
                                     "rationale": "Cross-department handoff."})
            draft_content = (
                f"# {role} — {subject}\n\n## Objective\n{obj_line}\n\n## Deliverable\n"
                "Prepared the recurring deliverable for this objective (stub draft). Concrete next "
                "actions were created as tasks and routed to the partner departments below.\n\n"
                "## Handoffs\n" + ("\n".join(f"- {k}" for k in targets) if targets else "- (none)")
            )
            n_tasks = len([i for i in pintents if i["tool"] == "create_task"])
            n_hand = len([i for i in pintents if i["tool"] == "handoff"])
            result = {
                "draft": {"kind": "note", "subject": f"[Proactive] {subject}", "content": draft_content, "recipients": [], "citations": citations},
                "reasoning_summary": f"Proactive run for {role}: deliverable produced, {n_tasks} task(s) created, handed off to {n_hand} department(s). [stub provider]",
                "confidence": 0.8,
                "needs_escalation": False,
                "escalate_to": None,
                "tool_intents": pintents,
            }
            return result, {"input": 0, "output": 0, "stub": True, "requested_provider": self.requested, "proactive": True}

        if key == "ai_executive_assistant":
            draft_kind = "email_reply"
            draft_subject = f"Re: {subject}"
            recipients = [sender]
            draft_content = (
                f"Hi,\n\nThanks for your note. {role_hint} I've reviewed the request regarding \"{subject}\" "
                f"and propose the following next step. I'll confirm the details and follow up shortly.\n\nBest regards,\nDynamicsOps"
            )
            reasoning = "Triaged inbound email; the intent is clear and routine. Drafting a reply and proposing a calendar update."
            if getattr(activity, "channel", "") == "whatsapp" and "send_whatsapp_message" in tools:
                intents.append({"tool": "send_whatsapp_message", "sensitive": True, "args": {"body": draft_content}, "rationale": "Reply on WhatsApp."})
            elif "send_email" in tools:
                intents.append({"tool": "send_email", "sensitive": True, "args": {"to": recipients, "subject": draft_subject, "body": draft_content}, "rationale": "Reply to the sender."})
            if "update_calendar_event" in tools and ("call" in body.lower() or "meeting" in body.lower() or "move" in body.lower()):
                intents.append({"tool": "update_calendar_event", "sensitive": True, "args": {"title": subject, "note": "rescheduled per request"}, "rationale": "Apply the requested reschedule."})

        elif key == "ai_sales_assistant":
            draft_kind = "email_reply"
            draft_subject = f"Re: {subject}"
            recipients = [sender]
            draft_content = f"Hi,\n\nThanks for your interest in DynamicsOps. {role_hint} Happy to help with your Dynamics 365 needs — could you share your timeline and scope so we can tailor next steps?\n\nBest,\nDynamicsOps Sales"
            reasoning = "Inbound lead; qualifying and logging the opportunity in CRM, then drafting a follow-up."
            confidence = 0.78
            if "crm_update_record" in tools:
                intents.append({"tool": "crm_update_record", "sensitive": True, "args": {"entity": "opportunity", "name": cust, "stage": "qualifying"}, "rationale": "Log/refresh the opportunity."})
            if "send_email" in tools:
                intents.append({"tool": "send_email", "sensitive": True, "args": {"to": recipients, "subject": draft_subject, "body": draft_content}, "rationale": "Qualify the lead."})

        elif key == "ai_proposal_manager":
            draft_kind = "proposal"
            draft_subject = f"Proposal — {cust}"
            if re.search(r"\bGENERALIZE\b", body, re.I):
                draft_subject = f"Reusable template — {subject}"
                draft_content = (
                    "# Proposal for {{customer}}\n\n"
                    "## Executive Summary\n{{customer}} is evaluating {{solution_area}}. This proposal outlines the scope, approach, timeline, and commercial model for {{scope}}.\n\n"
                    "## Scope\n- {{scope_item_1}}\n- {{scope_item_2}}\n- {{scope_item_3}}\n\n"
                    "## Delivery Approach\nDiscovery, design, implementation, validation, and handover will be delivered by DynamicsOps using Microsoft Dynamics 365 and Power Platform best practices.\n\n"
                    "## Effort and Timeline\nEstimated effort: {{effort_days}} consultant-days.\nTarget start date: {{date}}.\n\n"
                    "## Commercials\nPrice: {{price}} {{currency}}. Final pricing and terms require approval.\n\n"
                    "## Assumptions\n{{assumptions}}\n\n## Next Steps\n{{next_steps}}"
                )
                reasoning = "Generalized a sent proposal into a reusable parameterized template with customer, scope, effort, price, and date placeholders."
            else:
                draft_content = f"# Proposal for {cust}\n\n## Scope\nDynamics 365 engagement per request: {subject}.\n\n## Indicative Effort\n~45 man-days (from rate catalog).\n\n## Commercials\nDraft pricing pending review."
                reasoning = "Assembled a proposal draft from templates and the rate catalog; pricing requires approval before sending."
            confidence = 0.74
            if "create_document" in tools:
                intents.append({"tool": "create_document", "sensitive": False, "args": {"title": draft_subject, "kind": "proposal"}, "rationale": "Persist the proposal draft."})
            if "generate_quote" in tools:
                intents.append({"tool": "generate_quote", "sensitive": True, "args": {"customer": cust, "amount": 67500, "currency": "USD"}, "rationale": "Produce priced quote."})

        elif key == "ai_project_manager":
            draft_kind = "task_plan"
            transcript_like = bool(re.search(r"\b(transcript|meeting notes|minutes)\b", f"{subject}\n{body}", re.I))
            action_items = _extract_action_items(body)
            if transcript_like and not action_items:
                action_items = [
                    {"owner": "Project Manager", "action": f"Confirm scope and owners for {subject}", "due": "next business day"},
                    {"owner": "Delivery Team", "action": "Update the delivery plan with decisions and dependencies", "due": "this week"},
                    {"owner": "Client Owner", "action": "Validate open questions and required approvals", "due": "this week"},
                ]
            if not action_items:
                action_items = [{"owner": "Project Manager", "action": f"Follow up on {subject}", "due": "next business day"}]

            summary = _five_bullet_summary(body or subject)
            table = ["| Action | Owner | Due |", "| --- | --- | --- |"]
            for item in action_items:
                table.append(f"| {item['action']} | {item['owner']} | {item['due']} |")
            draft_content = "# Meeting Summary\n\n" + "\n".join(f"- {s}" for s in summary) + "\n\n## Action Items\n\n" + "\n".join(table)
            reasoning = f"Extracted {len(action_items)} structured action item(s); creating internal tasks and proposing Azure DevOps tracking where allowed."
            if "create_task" in tools:
                for item in action_items:
                    intents.append({
                        "tool": "create_task",
                        "sensitive": False,
                        "args": {
                            "title": item["action"][:280],
                            "description": f"Owner: {item['owner']}\nDue: {item['due']}\nSource: {subject}",
                            "owner": item["owner"],
                            "due": item["due"],
                        },
                        "rationale": "Track extracted meeting action item.",
                    })
            if "devops_create_workitem" in tools:
                first = action_items[0]
                intents.append({"tool": "devops_create_workitem", "sensitive": True, "args": {"type": "Task", "title": first["action"][:280], "project": (activity.project.name if activity.project else None), "description": f"Owner: {first['owner']}\nDue: {first['due']}"}, "rationale": "Track the top meeting action item in ADO."})

        elif key == "ai_functional_consultant":
            draft_kind = "note"
            draft_content = f"Functional notes for {cust}:\n- Requirement: {subject}\n- Proposed D365 module mapping and 3 draft user stories with acceptance criteria."
            reasoning = "Mapped the requirement to D365 modules and drafted user stories grounded in the knowledge base."
            if "create_document" in tools:
                intents.append({"tool": "create_document", "sensitive": False, "args": {"title": f"Functional design — {subject}"}, "rationale": "Persist functional design."})

        elif key == "ai_technical_consultant":
            draft_kind = "note"
            draft_content = f"Technical analysis for \"{subject}\":\n- Likely cause and a proposed fix plan.\n- Recommend a tracked work item / GitHub issue for the change."
            reasoning = "Reviewed the technical issue, drafted a fix plan, and proposed tracked items in ADO/GitHub."
            confidence = 0.71
            if "devops_create_workitem" in tools:
                intents.append({"tool": "devops_create_workitem", "sensitive": True, "args": {"type": "Bug", "title": subject}, "rationale": "Track the defect."})
            if "github_create_issue" in tools and ("github" in body.lower() or "repo" in body.lower() or "pr" in body.lower()):
                intents.append({"tool": "github_create_issue", "sensitive": True, "args": {"title": subject, "body": draft_content}, "rationale": "Open a GitHub issue."})

        elif key == "ai_support_agent":
            draft_kind = "email_reply"
            draft_subject = f"Re: {subject}"
            recipients = [sender]
            draft_content = f"Hi,\n\nThanks for reaching out. {role_hint} Based on our knowledge base, here are steps to resolve the issue. I've logged a ticket and will keep you updated.\n\nDynamicsOps Support"
            reasoning = "Classified severity, matched a KB article, opened a ticket, and drafted a customer reply."
            confidence = 0.7
            if "create_ticket" in tools:
                intents.append({"tool": "create_ticket", "sensitive": False, "args": {"subject": subject, "severity": "medium"}, "rationale": "Track the support request."})
            # Reply on the channel the request arrived on.
            if getattr(activity, "channel", "") == "whatsapp" and "send_whatsapp_message" in tools:
                intents.append({"tool": "send_whatsapp_message", "sensitive": True, "args": {"body": draft_content}, "rationale": "Reply to the customer on WhatsApp."})
            elif "send_email" in tools:
                intents.append({"tool": "send_email", "sensitive": True, "args": {"to": recipients, "subject": draft_subject, "body": draft_content}, "rationale": "Reply with the solution."})

        elif key == "ai_finance_assistant":
            company = "Dynamics Ops Bilgi Tek Ltd Sti"
            draft_kind = "email_reply"
            draft_subject = f"Re: {subject}"
            recipients = [sender]
            draft_content = f"Hello,\n\nRegarding {subject}: please find the balance summary. A reminder/invoice will follow after internal approval.\n\nDynamicsOps Finance"
            reasoning = f"Checked Business Central ({company}); drafting a finance reply. Any invoice/payment requires approval and respects the limit."
            confidence = 0.76
            if "bc_read_balance" in tools:
                intents.append({"tool": "bc_read_balance", "sensitive": False, "args": {"company": company, "customer": cust}, "rationale": "Read current balance."})
            if "bc_create_invoice" in tools and "invoice" in (subject + body).lower():
                intents.append({"tool": "bc_create_invoice", "sensitive": True, "args": {"company": company, "customer": cust, "amount": 12500, "currency": "USD"}, "rationale": "Create the requested invoice."})

        elif key == "ai_hr_admin_assistant":
            draft_kind = "chat_reply"
            draft_content = f"Hi! {role_hint} Regarding \"{subject}\": here's the relevant policy and the next step. I'll create a task to track it."
            reasoning = "Answered the internal HR/admin request from policy and created a tracking task."
            if "create_task" in tools:
                intents.append({"tool": "create_task", "sensitive": False, "args": {"title": f"HR follow-up: {subject}"}, "rationale": "Track the request."})

        elif key == "ai_knowledge_manager":
            draft_kind = "note"
            hit_titles = ", ".join(h.get("title") or "source" for h in rag_hits) or "the knowledge base"
            draft_content = f"Answer to \"{subject}\" grounded in {hit_titles}. Citations attached."
            reasoning = "Answered the internal query strictly from retrieved knowledge with citations."
            confidence = 0.8 if rag_hits else 0.55
            escalate = not rag_hits

        elif key == "ai_data_analyst":
            draft_kind = "note"
            body_lower = body.lower()
            # Pick the most relevant report from the catalog based on keywords.
            if "approval" in body_lower:
                report_key = "approvals_by_status"
                chart_title = "Approvals by Status"
            elif "mission" in body_lower:
                report_key = "missions_overview"
                chart_title = "Missions Overview"
            elif "task" in body_lower:
                report_key = "tasks_by_status"
                chart_title = "Tasks by Status"
            elif "proactive" in body_lower:
                report_key = "proactive_by_resource"
                chart_title = "Proactive Activities by Resource"
            elif any(kw in body_lower for kw in ("resource", "who", "which resource", "per resource")):
                report_key = "activities_by_resource"
                chart_title = "Activities by Resource"
            else:
                report_key = "activities_by_status"
                chart_title = "Activities by Status"
            draft_content = (
                f"# Analytics: {subject}\n\n"
                f"I selected the **{report_key}** report from the catalog as the best match for your question.\n\n"
                f"The chart below shows {chart_title.lower()}. Review the data and let me know if you need a different breakdown."
            )
            reasoning = f"Picked report '{report_key}' based on question keywords; emitting run_report and make_chart intents."
            confidence = 0.82
            if "run_report" in tools:
                intents.append({
                    "tool": "run_report",
                    "sensitive": False,
                    "args": {"report": report_key},
                    "rationale": f"Execute the '{report_key}' report from the safe catalog.",
                })
            if "make_chart" in tools:
                intents.append({
                    "tool": "make_chart",
                    "sensitive": False,
                    "args": {"type": "bar", "title": chart_title},
                    "rationale": "Render the report data as a bar chart.",
                })

        else:
            role = getattr(resource, "name", key.replace("_", " "))
            draft_kind = "note"
            draft_subject = f"{role} — {subject}"
            draft_content = (
                f"# {role} Draft\n\n"
                f"## Summary\n"
                f"Reviewed the request for {cust}: {subject}.\n\n"
                f"## Recommended Approach\n"
                "Use a standard-first path: confirm out-of-box fit, then low-code/platform configuration, "
                "then extension or custom build only where the gap is justified.\n\n"
                f"## Assumptions\n"
                f"- Context is limited to the supplied activity and retrieved knowledge.\n"
                f"- The client-ready deliverable should be refined after stakeholder review.\n\n"
                f"## Next Actions\n"
                "- Validate facts and constraints with the client.\n"
                "- Convert accepted recommendations into tracked delivery tasks."
            )
            reasoning = f"Produced a role-appropriate consulting draft for {role} using the generic graph."
            confidence = 0.72
            if "create_document" in tools:
                intents.append({
                    "tool": "create_document",
                    "sensitive": False,
                    "args": {"title": draft_subject, "kind": "consulting_note", "content": draft_content},
                    "rationale": "Persist the client-ready consulting draft.",
                })

        # 2c: Emit a `remember` intent with a one-line learning in the generic/consulting path
        if "remember" in tools and draft_content and not escalate:
            learning = f"{subject[:120]}: {reasoning[:160]}"
            intents.append({
                "tool": "remember",
                "sensitive": False,
                "args": {"content": learning, "scope": "general"},
                "rationale": "Persist key learning for future runs.",
            })

        # Honor the resource's allowed tools (defense-in-depth; Node re-validates too).
        intents = [i for i in intents if i["tool"] in tools]

        result = {
            "draft": {"kind": draft_kind, "subject": draft_subject, "content": draft_content, "recipients": recipients, "citations": citations},
            "reasoning_summary": reasoning + (f" [stub provider; requested {self.requested}]" if True else ""),
            "confidence": confidence,
            "needs_escalation": escalate,
            "escalate_to": escalate_to,
            "tool_intents": intents,
        }
        return result, {"input": 0, "output": 0, "stub": True, "requested_provider": self.requested}


def _clean_bullet(line: str) -> str:
    return re.sub(r"^\s*(?:[-*•]|\d+[\.)])\s*", "", line).strip()


def _extract_action_items(body: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for raw in (body or "").splitlines():
        line = _clean_bullet(raw)
        if not line:
            continue
        owner = None
        owner_match = re.match(r"\[([^\]]{1,80})\]\s*(.+)", line)
        if owner_match:
            owner = owner_match.group(1).strip()
            line = owner_match.group(2).strip()
        elif re.search(r"\b(action|todo|follow up|owner|due)\b", line, re.I):
            owner_match = re.match(r"([A-Z][A-Za-z .'-]{1,60}):\s*(.+)", line)
            if owner_match:
                owner = owner_match.group(1).strip()
                line = owner_match.group(2).strip()
        if not owner and not re.search(r"\b(action|todo|follow up|due|by\s+\w+day|by\s+\d|owner)\b", line, re.I):
            continue

        due = "not specified"
        due_match = re.search(r"\((?:due|by)\s+([^)]+)\)", line, re.I) or re.search(r"\bdue[:\s]+([^.;]+)", line, re.I)
        if due_match:
            due = due_match.group(1).strip()
            line = re.sub(r"\s*\((?:due|by)\s+[^)]+\)", "", line, flags=re.I)
            line = re.sub(r"\s*\bdue[:\s]+[^.;]+", "", line, flags=re.I).strip()
        items.append({"owner": owner or "Unassigned", "action": line[:280], "due": due})
        if len(items) >= 5:
            break
    return items


def _five_bullet_summary(text: str) -> list[str]:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text or "") if s.strip()]
    bullets = [re.sub(r"\s+", " ", _clean_bullet(s))[:180] for s in sentences[:5]]
    while len(bullets) < 5:
        bullets.append("No additional decision captured in the supplied transcript.")
    return bullets[:5]
