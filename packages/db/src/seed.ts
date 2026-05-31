import { PrismaClient, Prisma } from '@prisma/client';
import { ALL_RESOURCE_DEFS } from '@dynops/shared';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding DynamicsOps AI Resource Platform…');

  // ── Users (one per role) ────────────────────────────────────────────────
  const admin = await prisma.users.upsert({
    where: { email: 'admin@dynamicsops.com' },
    update: {},
    create: { email: 'admin@dynamicsops.com', display_name: 'Platform Admin', role: 'admin', approval_limit: new Prisma.Decimal(1000000) },
  });
  const manager = await prisma.users.upsert({
    where: { email: 'manager@dynamicsops.com' },
    update: {},
    create: { email: 'manager@dynamicsops.com', display_name: 'Ops Manager', role: 'manager', approval_limit: new Prisma.Decimal(50000), manager_id: admin.id },
  });
  await prisma.users.upsert({
    where: { email: 'consultant@dynamicsops.com' },
    update: {},
    create: { email: 'consultant@dynamicsops.com', display_name: 'Senior Consultant', role: 'consultant', approval_limit: new Prisma.Decimal(5000), manager_id: manager.id },
  });
  const viewer = await prisma.users.upsert({
    where: { email: 'viewer@dynamicsops.com' },
    update: {},
    create: { email: 'viewer@dynamicsops.com', display_name: 'Viewer', role: 'viewer', manager_id: manager.id },
  });
  const consultant = await prisma.users.findUnique({ where: { email: 'consultant@dynamicsops.com' } });

  // ── Default workspace (multi-tenant) + memberships ──────────────────────
  const WS_ID = '00000000-0000-0000-0000-0000000000ff';
  await prisma.workspaces.upsert({
    where: { id: WS_ID },
    update: {},
    create: {
      id: WS_ID,
      name: 'DynamicsOps',
      slug: 'dynamicsops',
      plan: 'enterprise',
      branding: { display_name: 'DynamicsOps', accent_hue: 252, accent_sat: 83, accent_lum: 60 },
      limits: { seats: 50, monthly_token_budget: 5_000_000 },
    },
  });
  for (const u of [admin, manager, consultant, viewer].filter(Boolean) as { id: string; role: any }[]) {
    await prisma.memberships.upsert({
      where: { workspace_id_user_id: { workspace_id: WS_ID, user_id: u.id } },
      update: {},
      create: { workspace_id: WS_ID, user_id: u.id, role: u.role },
    });
  }

  // ── AI Resources (operational + consulting + business digital employees) ──
  const defaultEmail = (def: { key: string; email?: string }) =>
    def.email ?? `${def.key.replace(/^ai_/, '').replace(/_/g, '.')}@dynamicsops.com`;
  const resourceByKey: Record<string, string> = {};
  for (const def of ALL_RESOURCE_DEFS) {
    const existing = await prisma.ai_resources.findUnique({ where: { key: def.key } });
    const existingConfig = (existing?.config as Record<string, unknown> | null) ?? {};
    const config = { ...existingConfig, category: def.category ?? 'operational', skill: def.skill ?? def.key };
    const r = await prisma.ai_resources.upsert({
      where: { key: def.key },
      // NOTE: llm_provider / llm_model / email are intentionally NOT in `update` so
      // an admin's model & mailbox choices (Directory/PATCH) survive re-seeds.
      update: {
        name: def.name,
        role: def.role,
        description: def.description,
        system_prompt: def.systemPrompt,
        allowed_tools: def.tools as unknown as Prisma.InputJsonValue,
        temperature: new Prisma.Decimal(def.temperature),
        confidence_threshold: new Prisma.Decimal(def.confidenceThreshold),
        approval_limit: def.approvalLimit === null ? null : new Prisma.Decimal(def.approvalLimit),
        config: config as Prisma.InputJsonValue,
        escalation_manager_id: manager.id,
        status: 'active',
      },
      create: {
        key: def.key,
        name: def.name,
        role: def.role,
        email: defaultEmail(def),
        description: def.description,
        system_prompt: def.systemPrompt,
        llm_provider: def.provider,
        llm_model: def.model,
        temperature: new Prisma.Decimal(def.temperature),
        allowed_tools: def.tools as unknown as Prisma.InputJsonValue,
        config: config as Prisma.InputJsonValue,
        confidence_threshold: new Prisma.Decimal(def.confidenceThreshold),
        approval_limit: def.approvalLimit === null ? null : new Prisma.Decimal(def.approvalLimit),
        escalation_manager_id: manager.id,
        status: 'active',
        metrics: { handled: 0, escalations: 0, avg_confidence: 0 },
      },
    });
    resourceByKey[def.key] = r.id;
    // Backfill a default mailbox for resources created before the email column
    // existed (only when still null — never clobber an admin-set address).
    await prisma.ai_resources.updateMany({ where: { key: def.key, email: null }, data: { email: defaultEmail(def) } });
  }

  // ── Proactive automations (recurring department jobs) ────────────────────
  const cadenceMs: Record<string, number> = { daily: 86400_000, weekly: 7 * 86400_000, monthly: 30 * 86400_000, quarterly: 90 * 86400_000 };
  let automationCount = 0;
  for (const def of ALL_RESOURCE_DEFS) {
    for (const a of def.automations ?? []) {
      await prisma.automations.upsert({
        where: { resource_id_name: { resource_id: resourceByKey[def.key], name: a.name } },
        // Preserve scheduler run-state (is_active / next_run_at / last_run_at)
        // across re-seeds; only refresh the editable content.
        update: { objective: a.objective, cadence: a.cadence, handoff_to: a.handoffTo as Prisma.InputJsonValue, sample_tasks: a.sampleTasks as Prisma.InputJsonValue },
        create: {
          resource_id: resourceByKey[def.key],
          name: a.name,
          objective: a.objective,
          cadence: a.cadence,
          handoff_to: a.handoffTo as Prisma.InputJsonValue,
          sample_tasks: a.sampleTasks as Prisma.InputJsonValue,
          is_active: true,
          next_run_at: null, // null → first scheduler tick runs it once, then cadence
          config: { cadence_ms: cadenceMs[a.cadence] ?? cadenceMs.weekly },
        },
      });
      automationCount++;
    }
  }

  // ── Connection Registry (integrations — one row per connection) ──────────
  const integrations: { type: any; name: string; direction: any; config: Prisma.InputJsonValue }[] = [
    { type: 'graph_email', name: 'DynamicsOps Mailbox (mock)', direction: 'both', config: { mailbox: 'ops@dynamicsops.com' } },
    { type: 'graph_calendar', name: 'DynamicsOps Calendar (mock)', direction: 'both', config: {} },
    { type: 'graph_teams', name: 'DynamicsOps Teams (mock)', direction: 'both', config: {} },
    { type: 'opsconnect', name: 'OpsConnect Portal+Hub (mock)', direction: 'both', config: { base_url: 'https://opsconnect.dynamicsops.com', projects: ['Contoso F&O', 'Northwind BC'] } },
    { type: 'ado_org', name: 'ADO: dynamicsops (mock)', direction: 'both', config: { org: 'dynamicsops' } },
    { type: 'ado_org', name: 'ADO: dynops-delivery (mock)', direction: 'both', config: { org: 'dynops-delivery' } },
    { type: 'github', name: 'GitHub: dynamicsops/AIResources (mock)', direction: 'both', config: { repo: 'dynamicsops/AIResources' } },
    { type: 'github', name: 'GitHub: dynamicsops/DynOpsBC (mock)', direction: 'both', config: { repo: 'dynamicsops/DynOpsBC' } },
    { type: 'business_central', name: 'BC: Dynamics Ops Bilgi Tek Ltd Sti (mock)', direction: 'both', config: { tenant: '7fa2357e-26f2-4174-8e16-a713981356b8', environment: 'Production', company: 'Dynamics Ops Bilgi Tek Ltd Sti' } },
    { type: 'business_central', name: 'BC: Dynamics Ops (mock)', direction: 'both', config: { tenant: '7fa2357e-26f2-4174-8e16-a713981356b8', environment: 'Production', company: 'Dynamics Ops' } },
  ];
  const integrationByName: Record<string, string> = {};
  for (const i of integrations) {
    // NOTE: update is a no-op so a connection flipped LIVE (is_mock=false +
    // real config/credentials_ref) by an admin survives re-seeds / restarts.
    const row = await prisma.integrations.upsert({
      where: { type_name: { type: i.type, name: i.name } },
      update: {},
      create: { type: i.type, name: i.name, direction: i.direction, config: i.config, status: 'mock', is_mock: true },
    });
    integrationByName[i.name] = row.id;
  }

  // ── Content / proposal templates ───────────────────────────────────────
  const templates: { name: string; type: string; content: string; metadata?: Prisma.InputJsonValue }[] = [
    {
      name: 'LinkedIn Thought Leadership Post',
      type: 'social_post',
      content: 'Hook: {{hook}}\n\nContext: {{market_signal}}\n\nDynamicsOps perspective: {{point_of_view}}\n\nPractical next step: {{call_to_action}}\n\nTags: {{hashtags}}',
      metadata: { seeded: true, channel: 'linkedin' },
    },
    {
      name: 'X Short Insight Post',
      type: 'social_post',
      content: '{{short_hook}}\n\n{{insight}}\n\nNext: {{call_to_action}}\n{{hashtags}}',
      metadata: { seeded: true, channel: 'x' },
    },
    {
      name: 'Product Launch Announcement',
      type: 'product_announcement',
      content: '# {{product_name}}\n\n## Audience\n{{target_audience}}\n\n## Problem\n{{customer_pain}}\n\n## Announcement Post\n{{announcement_post}}\n\n## Customer Email\nSubject: {{email_subject}}\n\n{{email_body}}\n\n## Blog Blurb\n{{blog_blurb}}\n\n## Review Checklist\n- Claims verified\n- Pricing approved\n- Sender/publisher approved',
      metadata: { seeded: true },
    },
  ];
  for (const t of templates) {
    const existing = await prisma.templates.findFirst({ where: { workspace_id: WS_ID, type: t.type, name: t.name } });
    if (existing) {
      await prisma.templates.update({ where: { id: existing.id }, data: { content: t.content, metadata: t.metadata ?? {} } });
    } else {
      await prisma.templates.create({ data: { workspace_id: WS_ID, name: t.name, type: t.type, content: t.content, metadata: t.metadata ?? {}, created_by: manager.id } });
    }
  }

  // ── Activity sources (inbound channels) ──────────────────────────────────
  const mailSource = await prisma.activity_sources.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000a1' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000a1',
      name: 'Mock Mailbox',
      channel: 'email',
      integration_id: integrationByName['DynamicsOps Mailbox (mock)'],
      external_ref: 'ops@dynamicsops.com',
    },
  });
  await prisma.activity_sources.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000a2' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000a2',
      name: 'OpsConnect Intake',
      channel: 'opsconnect',
      integration_id: integrationByName['OpsConnect Portal+Hub (mock)'],
      external_ref: 'https://opsconnect.dynamicsops.com',
    },
  });

  // ── Sample customers + projects ──────────────────────────────────────────
  const contoso = await prisma.customers.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000c1' },
    update: {},
    create: { id: '00000000-0000-0000-0000-0000000000c1', name: 'Contoso Ltd', domain: 'contoso.com', industry: 'Manufacturing', tier: 'enterprise' },
  });
  await prisma.projects.upsert({
    where: { code: 'CON-FO-2' },
    update: {},
    create: { id: '00000000-0000-0000-0000-0000000000d1', customer_id: contoso.id, name: 'Contoso F&O Phase 2', code: 'CON-FO-2', status: 'active', devops_project: 'Contoso-FO' },
  });

  // ── Workflow + rules (wf_core_routing — the §7 set) ──────────────────────
  const wf = await prisma.workflows.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000f1' },
    update: {},
    create: { id: '00000000-0000-0000-0000-0000000000f1', name: 'wf_core_routing', description: 'Core inbound routing', is_active: true, priority: 100 },
  });

  type RuleSeed = {
    id: string;
    name: string;
    phase: string;
    priority: number;
    condition: Prisma.InputJsonValue;
    action_type: any;
    target?: string;
    action_config?: Prisma.InputJsonValue;
    set_priority?: any;
    stop_on_match?: boolean;
  };

  const rules: RuleSeed[] = [
    { id: 'f0000000-0000-0000-0000-000000000010', name: 'Invoice/payment → Finance', phase: 'pre_agent', priority: 10, action_type: 'route_to_resource', target: 'ai_finance_assistant', set_priority: 'high',
      condition: { any: [{ field: 'subject', op: 'matches', value: '(?i)(invoice|payment due|remittance|billing)' }, { field: 'body', op: 'matches', value: '(?i)(invoice|payment)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000015', name: 'BC invoice/payment event → Finance', phase: 'pre_agent', priority: 15, action_type: 'route_to_resource', target: 'ai_finance_assistant',
      condition: { all: [{ field: 'channel', op: 'eq', value: 'business_central' }] } },
    { id: 'f0000000-0000-0000-0000-000000000020', name: 'Support request → Support Agent', phase: 'pre_agent', priority: 20, action_type: 'route_to_resource', target: 'ai_support_agent',
      condition: { any: [{ field: 'body', op: 'matches', value: "(?i)(error|not working|bug|issue|can't|cannot|broken)" }, { field: 'category', op: 'eq', value: 'support' }] } },
    { id: 'f0000000-0000-0000-0000-000000000025', name: 'OpsConnect intake → Support/PM', phase: 'pre_agent', priority: 25, action_type: 'route_to_resource', target: 'ai_project_manager',
      condition: { all: [{ field: 'channel', op: 'eq', value: 'opsconnect' }] } },
    { id: 'f0000000-0000-0000-0000-000000000030', name: 'Meeting transcript → Project Manager', phase: 'pre_agent', priority: 30, action_type: 'route_to_resource', target: 'ai_project_manager',
      condition: { all: [{ field: 'channel', op: 'eq', value: 'document' }, { field: 'subject', op: 'matches', value: '(?i)(transcript|meeting notes|minutes)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000040', name: 'Proposal/RFP → Sales', phase: 'pre_agent', priority: 40, action_type: 'route_to_resource', target: 'ai_sales_assistant',
      condition: { any: [{ field: 'body', op: 'matches', value: '(?i)(proposal|quote|SOW|statement of work|RFP|pricing for)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000050', name: 'Technical issue → Technical Consultant', phase: 'pre_agent', priority: 50, action_type: 'route_to_resource', target: 'ai_technical_consultant', set_priority: 'high',
      condition: { any: [{ field: 'body', op: 'matches', value: '(?i)(plugin|integration|API|deployment|exception|stack trace|customization)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000035', name: 'ADO/GitHub item → Technical Consultant', phase: 'pre_agent', priority: 35, action_type: 'route_to_resource', target: 'ai_technical_consultant',
      condition: { any: [{ field: 'channel', op: 'eq', value: 'devops' }, { field: 'channel', op: 'eq', value: 'github' }] } },
    { id: 'f0000000-0000-0000-0000-000000000044', name: 'Business Central / e-dönüşüm → Functional Consultant', phase: 'pre_agent', priority: 44, action_type: 'route_to_resource', target: 'ai_functional_consultant',
      condition: { any: [{ field: 'subject', op: 'matches', value: '(?i)(business central|e-dönüşüm|edönüşüm|e-fatura|\\bBC\\b)' }, { field: 'body', op: 'matches', value: '(?i)(business central|e-dönüşüm|edönüşüm|e-fatura)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000046', name: 'Build/pipeline/deploy → Technical Consultant', phase: 'pre_agent', priority: 46, action_type: 'route_to_resource', target: 'ai_technical_consultant',
      condition: { any: [{ field: 'subject', op: 'matches', value: '(?i)(build failed|build succeeded|pipeline|fodevpipeline|manual validation|deployment)' }, { field: 'body', op: 'matches', value: '(?i)(pipeline|deployment|build failed)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000048', name: 'Report/Power BI → Functional Consultant', phase: 'pre_agent', priority: 48, action_type: 'route_to_resource', target: 'ai_functional_consultant',
      condition: { any: [{ field: 'subject', op: 'matches', value: '(?i)(rapor|report|power bi|dashboard|müşteri raporlar)' }] } },
    { id: 'f0000000-0000-0000-0000-000000000090', name: 'Low confidence → approval', phase: 'post_agent', priority: 90, action_type: 'escalate', stop_on_match: false,
      condition: { any: [{ field: 'agent_result.needs_escalation', op: 'eq', value: true }] }, action_config: { reason: 'low_confidence_or_escalation', assignee_role: 'manager' } },
    { id: 'f0000000-0000-0000-0000-000000000095', name: 'Sensitive tool → approval', phase: 'post_agent', priority: 95, action_type: 'escalate', stop_on_match: false,
      condition: { any: [{ field: 'agent_result.has_sensitive_tool', op: 'eq', value: true }] }, action_config: { reason: 'sensitive_action', assignee_role: 'manager' } },
    { id: 'f0000000-0000-0000-0000-000000001000', name: 'Default → Executive Assistant', phase: 'pre_agent', priority: 1000, action_type: 'route_to_resource', target: 'ai_executive_assistant',
      condition: { any: [{ field: 'channel', op: 'eq', value: 'email' }, { field: 'channel', op: 'eq', value: 'teams' }, { field: 'channel', op: 'eq', value: 'manual' }] } },
  ];

  // ── Keyword routing for EVERY consulting + business resource ──────────────
  // Generated rules sit at priority 300+ (after the core §7 specifics at 10-50,
  // before the default at 1000) so every resource is reachable from the Workflow
  // engine. Keyword lists (EN + TR) match against subject OR body.
  const ROLE_ROUTING: Record<string, string[]> = {
    // consulting
    ai_solution_architect: ['solution architecture', 'target operating model', 'solution blueprint', 'architecture review', 'design governance', 'mimari'],
    ai_d365fo_functional: ['finance and operations', 'f&scm', 'f&o functional', 'supply chain', 'procurement', 'warehousing', 'fit-gap'],
    ai_bc_functional: ['business central functional', 'bc configuration', 'bc finance', 'dimensions', 'bc setup'],
    ai_ce_consultant: ['customer engagement', 'dynamics ce', 'customer service', 'field service', 'sales module', 'dataverse form'],
    ai_power_platform: ['power apps', 'power automate', 'canvas app', 'model-driven', 'low-code', 'power platform', 'dlp policy'],
    ai_xpp_architect: ['x++', 'chain of command', 'f&o extension', 'sysoperation', 'fo code review', 'batch job'],
    ai_al_developer: ['al extension', 'al code', 'codeunit', 'page extension', 'appsource app', 'pte extension'],
    ai_integration_architect: ['integration', 'rest api', 'webhook', 'logic apps', 'azure functions', 'middleware', 'odata', 'interface design'],
    ai_data_migration: ['data migration', 'data mapping', 'data cleansing', 'mock load', 'reconciliation', 'cutover data', 'legacy data'],
    ai_qa_lead: ['test plan', 'uat', 'regression', 'defect', 'test scenario', 'quality assurance', 'sit'],
    ai_delivery_pm: ['delivery plan', 'project governance', 'raid log', 'milestone', 'steering committee', 'stakeholder update'],
    ai_presales_discovery: ['discovery workshop', 'presales', 'scoping', 'estimate', 'solution fit', 'demo request'],
    ai_support_consultant: ['managed services', 'support ticket', 'incident', 'sla breach', 'rca', 'workaround'],
    ai_bi_reporting: ['power bi', 'reporting requirement', 'kpi', 'semantic model', 'analytics', 'rapor', 'dashboard'],
    ai_ux_ui_designer: ['ux', 'ui design', 'wireframe', 'usability', 'user experience', 'design spec'],
    ai_ai_strategist: ['ai strategy', 'copilot', 'automation roadmap', 'agentic', 'ai governance', 'ai readiness'],
    // business / department
    ai_finance_manager: ['budget', 'cash flow', 'forecast', 'margin', 'profitability', 'ebitda', 'fp&a', 'bütçe', 'nakit akışı', 'kâr marjı'],
    ai_accountant: ['invoice', 'fatura', 'e-fatura', 'e-defter', 'kdv', 'vat', 'reconciliation', 'mutabakat', 'bordro', 'tahsilat'],
    ai_marketing_manager: ['campaign', 'demand generation', 'content calendar', 'seo', 'webinar', 'co-marketing', 'brand', 'pazarlama', 'kampanya', 'etkinlik'],
    ai_ms_partner_manager: ['microsoft partner', 'solutions partner', 'maicpp', 'co-sell', 'marketplace', 'partner incentive', 'cpor', 'specialization', 'microsoft iş ortağı'],
    ai_license_manager: ['license', 'licensing', 'lisans', 'true-up', 'renewal', 'yenileme', 'csp', 'nce', 'seat'],
    ai_business_development: ['new business', 'lead', 'partnership', 'account expansion', 'upsell', 'iş ortaklığı', 'yeni müşteri', 'fırsat', 'teklif talebi'],
    ai_product_manager: ['product roadmap', 'appsource', 'accelerator', 'go-to-market', 'product launch', 'pricing', 'ürün yol haritası', 'ürün lansmanı', 'yeni ürün'],
    ai_hr_manager: ['hiring', 'interview', 'onboarding', 'certification', 'performance review', 'retention', 'ise alma', 'mülakat', 'performans', 'sertifika'],
    ai_social_content_manager: ['linkedin', 'social media', 'content calendar', 'thought leadership', 'blog post', 'employer brand', 'sosyal medya', 'içerik takvimi', 'gönderi'],
    ai_resourcing_manager: ['staffing', 'resource request', 'allocation', 'bench', 'utilization', 'capacity', 'kaynak atama', 'müsaitlik', 'kapasite'],
    ai_fo_project_manager: ['f&o project', 'f&scm project', 'finance and operations go-live', 'fo cutover', 'fo steering', 'devreye alma'],
    ai_bc_project_manager: ['business central project', 'bc implementation', 'bc go-live', 'bc cutover', 'bc status report', 'iş merkezi projesi', 'canlıya geçiş'],
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let prio = 300;
  for (const [key, kws] of Object.entries(ROLE_ROUTING)) {
    const alt = kws.map(esc).join('|');
    rules.push({
      id: `f3000000-0000-0000-0000-${String(prio).padStart(12, '0')}`,
      name: `Keyword → ${key.replace(/^ai_/, '').replace(/_/g, ' ')}`,
      phase: 'pre_agent',
      priority: prio++,
      action_type: 'route_to_resource',
      target: key,
      condition: { any: [{ field: 'subject', op: 'matches', value: `(?i)(${alt})` }, { field: 'body', op: 'matches', value: `(?i)(${alt})` }] },
    });
  }

  for (const r of rules) {
    await prisma.workflow_rules.upsert({
      where: { id: r.id },
      update: {},
      create: {
        id: r.id,
        workflow_id: wf.id,
        name: r.name,
        phase: r.phase,
        priority: r.priority,
        condition: r.condition,
        action_type: r.action_type,
        target_resource_id: r.target ? resourceByKey[r.target] : null,
        action_config: r.action_config ?? {},
        set_priority: r.set_priority ?? null,
        stop_on_match: r.stop_on_match ?? true,
      },
    });
  }

  // ── Backfill workspace_id on all tenant rows (idempotent) ───────────────
  const TENANT_TABLES = [
    'ai_resources', 'activity_sources', 'activities', 'customers', 'projects',
    'workflows', 'workflow_rules', 'agent_runs', 'tool_calls', 'approvals',
    'tasks', 'messages', 'documents', 'knowledge_chunks', 'integrations', 'audit_logs',
    'prompt_versions', 'notifications', 'templates', 'digest_results', 'automations',
  ];
  // audit_logs is append-only (trigger blocks UPDATE) — drop it for the backfill;
  // the API recreates the trigger on boot (which starts after this seed).
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_audit_logs_no_mutation ON audit_logs`);
  for (const t of TENANT_TABLES) {
    await prisma.$executeRawUnsafe(`UPDATE "${t}" SET workspace_id = '${WS_ID}'::uuid WHERE workspace_id IS NULL`);
  }

  console.log(`Seeded: ${ALL_RESOURCE_DEFS.length} AI resources, ${integrations.length} connections, ${rules.length} workflow rules, ${automationCount} proactive automations.`);
  console.log('Default workspace "DynamicsOps" + memberships created; tenant rows backfilled.');
  console.log('Dev logins: admin@dynamicsops.com | manager@dynamicsops.com | consultant@dynamicsops.com | viewer@dynamicsops.com');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
