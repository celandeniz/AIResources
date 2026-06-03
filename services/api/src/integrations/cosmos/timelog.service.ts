import { Injectable, Logger } from '@nestjs/common';
import { CosmosClient } from '@azure/cosmos';

// ─────────────────────────────────────────────────────────────────────────────
// COSMOS_MAP — single source of truth for container names and field names.
// Change these when the live schema changes; no other file needs to change.
// ─────────────────────────────────────────────────────────────────────────────
export const COSMOS_MAP = {
  // Container names
  CONTAINERS: {
    TIME_LOGS: 'core_time_logs',
    DEVOPS_TASKS: 'core_devops_tasks',
    CUSTOMERS: 'core_customers',
    COMPANIES: 'core_companies',
    USERS: 'core_users',
  },
  // core_time_logs field names
  TIME_LOG: {
    DOCUMENT_TYPE: 'document_type',
    DOCUMENT_TYPE_VALUE: 'time_log',
    HOURS: 'duration',           // string → Number
    USER_ID: 'user_id',
    TASK_ID: 'task_id',          // fallback: task_ado_id
    TASK_ID_FALLBACK: 'task_ado_id',
    TITLE: 'task_title',
    DATE_MS: 'start_time',       // epoch ms string → Number
    DATE_END_MS: 'end_time',
    DATE_STR: 'date',
    WORK_TYPE: 'work_type',
    COMMENT: 'comment',
    PROJECT: 'project_name',
    ORG: 'org_name',
    CUSTOMER_ID: 'customer_id',
    COMPANY_ID: 'company_id',
    IS_SENT: 'is_sent',
    IS_ONSITE: 'is_onsite',
  },
  // core_devops_tasks field names
  DEVOPS_TASK: {
    DOC_TYPE: 'doc_type',
    DOC_TYPE_VALUE: 'devops_task',
    ORIGINAL_ESTIMATE: 'original_estimate',
    COMPLETED_WORK: 'completed_work',
    LOGGED: 'logged',
    ESTIMATE: 'estimate',
    TITLE: 'title',
    TYPE: 'work_item_type',
    STATE: 'state',
    ASSIGNEE: 'assigned_to_name',
    WORK_ITEM_ID: 'ado_id',
    PRIORITY: 'priority',
    UPDATED_AT: 'updated_at',
    CHANGED_AT: 'changed_at',
    CREATED_AT: 'created_at',
    PROJECT: 'project_name',
    ORG: 'org_name',
    CUSTOMER_ID: 'customer_id',
    COMPANY_ID: 'company_id',
  },
  // core_customers field names (SECURITY: never select pat/pat_secret/client_secret/endpoint_url)
  CUSTOMER: {
    ID: 'id',
    ORG_NAME: 'org_name',
    DISPLAY_NAME: 'display_name',
    COMPANY_ID: 'company_id',
    STATUS: 'status',
    STATUS_ACTIVE: 'active',
    TYPE: 'type',
    TYPE_CUSTOMER: 'customer_tenant',
  },
  // core_users field names
  USER: {
    ID: 'id',
    NAME: 'name',
    EMAIL: 'email',
    JOB_ROLE: 'job_role_name',
  },
  // DynamicsOps internal company id (core_companies)
  DYNOPS_COMPANY_ID: '76a8c67d-ccd8-4b81-a5c4-3867ce5da588',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Canonical types returned by this service
// ─────────────────────────────────────────────────────────────────────────────
export interface CosmosOrg {
  id: string;
  org_name: string;
  display_name: string;
  company_id?: string;
}

export interface CosmosTimelog {
  id?: string;
  hours: number;
  userId: string;
  workItemId: string;
  title: string;
  dateMs: number;
  dateStr?: string;
  workType?: string;
  comment?: string;
  project: string;
  org?: string;
  customerId?: string;
  isSent?: boolean;
  isOnsite?: boolean;
}

export interface CosmosTask {
  workItemId: string;
  title: string;
  originalEstimate: number;
  completedWork: number;
  logged: number;
  type?: string;
  state?: string;
  assignee?: string;
  priority?: number;
  workItemType?: string;
  updatedAt?: string;
  changedAt?: string;
  createdAt?: string;
  project: string;
  org?: string;
  customerId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock data — returned when Cosmos credentials are not configured.
// Provides a realistic sample so the UI works without creds.
// ─────────────────────────────────────────────────────────────────────────────
const MOCK_ORGS: CosmosOrg[] = [
  { id: 'mock-org-aga', org_name: 'AGA Group', display_name: 'AGA Group', company_id: COSMOS_MAP.DYNOPS_COMPANY_ID },
  { id: 'mock-org-dynops', org_name: 'DynamicsOps Connect', display_name: 'DynamicsOps Connect', company_id: COSMOS_MAP.DYNOPS_COMPANY_ID },
];

const MOCK_TIME_LOGS: CosmosTimelog[] = [
  { id: 'tl-01', hours: 3, userId: 'user-deniz', workItemId: '101', title: 'Portal login screen', dateMs: 1745280000000, workType: 'Development', comment: 'Implemented OAuth2 flow', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-02', hours: 2, userId: 'user-deniz', workItemId: '102', title: 'API gateway setup', dateMs: 1745366400000, workType: 'Development', comment: 'Rate limiting configured', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-03', hours: 4, userId: 'user-ali', workItemId: '103', title: 'Database schema design', dateMs: 1745452800000, workType: 'Architecture', comment: 'ER diagram complete', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-04', hours: 2.5, userId: 'user-deniz', workItemId: '104', title: 'CI/CD pipeline', dateMs: 1745539200000, workType: 'DevOps', comment: 'GitHub Actions configured', project: 'AgaOne Dubai', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-05', hours: 5, userId: 'user-ali', workItemId: '105', title: 'Mobile app screens', dateMs: 1745625600000, workType: 'Development', comment: 'React Native components', project: 'AgaOne Dubai', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-06', hours: 3.5, userId: 'user-burak', workItemId: '101', title: 'Portal login screen', dateMs: 1745712000000, workType: 'Testing', comment: 'E2E tests written', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-07', hours: 2, userId: 'user-burak', workItemId: '106', title: 'Performance optimization', dateMs: 1745798400000, workType: 'Development', comment: 'Query caching added', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-08', hours: 1.5, userId: 'user-deniz', workItemId: '107', title: 'Deployment config', dateMs: 1745884800000, workType: 'DevOps', comment: 'Helm chart updated', project: 'AgaOne Dubai', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-09', hours: 4, userId: 'user-ali', workItemId: '108', title: 'BC integration', dateMs: 1745971200000, workType: 'Integration', comment: 'OData calls working', project: 'DynOps Connect', org: 'DynamicsOps Connect', customerId: 'mock-org-dynops' },
  { id: 'tl-10', hours: 3, userId: 'user-deniz', workItemId: '108', title: 'BC integration', dateMs: 1746057600000, workType: 'Integration', comment: 'Auth flow finished', project: 'DynOps Connect', org: 'DynamicsOps Connect', customerId: 'mock-org-dynops' },
  { id: 'tl-11', hours: 2, userId: 'user-burak', workItemId: '109', title: 'Report generation', dateMs: 1746144000000, workType: 'Development', comment: 'PDF layout built', project: 'DynOps Connect', org: 'DynamicsOps Connect', customerId: 'mock-org-dynops' },
  { id: 'tl-12', hours: 6, userId: 'user-ali', workItemId: '110', title: 'Data migration', dateMs: 1746230400000, workType: 'Data', comment: 'Legacy DB migrated', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-13', hours: 1, userId: 'user-deniz', workItemId: '111', title: 'Code review', dateMs: 1746316800000, workType: 'Review', comment: 'PR feedback given', project: 'AgaOne Dubai', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-14', hours: 2.5, userId: 'user-burak', workItemId: '112', title: 'Security audit', dateMs: 1746403200000, workType: 'Security', comment: 'Pen test findings resolved', project: 'Aga Digital', org: 'AGA Group', customerId: 'mock-org-aga' },
  { id: 'tl-15', hours: 3, userId: 'user-deniz', workItemId: '109', title: 'Report generation', dateMs: 1746489600000, workType: 'Development', comment: 'HTML snapshot done', project: 'DynOps Connect', org: 'DynamicsOps Connect', customerId: 'mock-org-dynops' },
];

const MOCK_TASKS: CosmosTask[] = [
  { workItemId: '101', title: 'Portal login screen', originalEstimate: 8, completedWork: 6.5, logged: 6.5, type: 'Task', state: 'Done', assignee: 'Deniz Celan', priority: 2, workItemType: 'Task', updatedAt: '2026-04-20T10:00:00Z', changedAt: '2026-04-20T10:00:00Z', createdAt: '2026-04-01T09:00:00Z', project: 'Aga Digital' },
  { workItemId: '102', title: 'API gateway setup', originalEstimate: 4, completedWork: 2, logged: 2, type: 'Task', state: 'Done', assignee: 'Deniz Celan', priority: 2, workItemType: 'Task', updatedAt: '2026-04-21T10:00:00Z', changedAt: '2026-04-21T10:00:00Z', createdAt: '2026-04-02T09:00:00Z', project: 'Aga Digital' },
  { workItemId: '103', title: 'Database schema design', originalEstimate: 6, completedWork: 4, logged: 4, type: 'Task', state: 'Done', assignee: 'Ali Yilmaz', priority: 1, workItemType: 'Task', updatedAt: '2026-04-22T10:00:00Z', changedAt: '2026-04-22T10:00:00Z', createdAt: '2026-04-03T09:00:00Z', project: 'Aga Digital' },
  { workItemId: '104', title: 'CI/CD pipeline', originalEstimate: 4, completedWork: 2.5, logged: 2.5, type: 'Task', state: 'Done', assignee: 'Deniz Celan', priority: 3, workItemType: 'Task', updatedAt: '2026-04-23T10:00:00Z', changedAt: '2026-04-23T10:00:00Z', createdAt: '2026-04-04T09:00:00Z', project: 'AgaOne Dubai' },
  { workItemId: '105', title: 'Mobile app screens', originalEstimate: 8, completedWork: 5, logged: 5, type: 'Feature', state: 'In Progress', assignee: 'Ali Yilmaz', priority: 1, workItemType: 'Feature', updatedAt: '2026-04-28T10:00:00Z', changedAt: '2026-04-28T10:00:00Z', createdAt: '2026-04-05T09:00:00Z', project: 'AgaOne Dubai' },
  { workItemId: '108', title: 'BC integration', originalEstimate: 10, completedWork: 7, logged: 7, type: 'Feature', state: 'Done', assignee: 'Ali Yilmaz', priority: 1, workItemType: 'Feature', updatedAt: '2026-04-29T10:00:00Z', changedAt: '2026-04-29T10:00:00Z', createdAt: '2026-04-06T09:00:00Z', project: 'DynOps Connect' },
  { workItemId: '109', title: 'Report generation', originalEstimate: 6, completedWork: 5, logged: 5, type: 'Task', state: 'Done', assignee: 'Deniz Celan', priority: 2, workItemType: 'Task', updatedAt: '2026-04-30T10:00:00Z', changedAt: '2026-04-30T10:00:00Z', createdAt: '2026-04-07T09:00:00Z', project: 'DynOps Connect' },
  { workItemId: '110', title: 'Data migration', originalEstimate: 8, completedWork: 6, logged: 6, type: 'Task', state: 'In Progress', assignee: 'Ali Yilmaz', priority: 2, workItemType: 'Task', updatedAt: '2026-04-30T10:00:00Z', changedAt: '2026-04-30T10:00:00Z', createdAt: '2026-04-08T09:00:00Z', project: 'Aga Digital' },
];

const MOCK_USERS: Record<string, string> = {
  'user-deniz': 'Deniz Celan',
  'user-ali': 'Ali Yilmaz',
  'user-burak': 'Burak Kaya',
};

// ─────────────────────────────────────────────────────────────────────────────
@Injectable()
export class CosmosTimelogService {
  private readonly logger = new Logger(CosmosTimelogService.name);
  private readonly client: CosmosClient | null;
  private readonly dbName: string;
  readonly mockMode: boolean;

  constructor() {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_READONLY_KEY ?? process.env.COSMOS_KEY;
    this.dbName = process.env.COSMOS_DB ?? 'DynOpsCore';

    if (endpoint && key) {
      this.client = new CosmosClient({ endpoint, key });
      this.mockMode = false;
      this.logger.log(`CosmosTimelogService: connected to ${endpoint} / ${this.dbName}`);
    } else {
      this.client = null;
      this.mockMode = true;
      this.logger.warn('CosmosTimelogService: COSMOS_ENDPOINT or COSMOS_READONLY_KEY not set — running in MOCK mode');
    }
  }

  private container(name: string) {
    if (!this.client) throw new Error('Cosmos client not initialised');
    return this.client.database(this.dbName).container(name);
  }

  // ── healthCheck ─────────────────────────────────────────────────────────────
  // Live probe used by the Integrations registry "Test" action.
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (this.mockMode) {
      return { ok: true, detail: 'Mock mode (no COSMOS_ENDPOINT/key set) — sample data served.' };
    }
    try {
      const orgs = await this.listOrganizations();
      const C = COSMOS_MAP.TIME_LOG;
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.TIME_LOGS).items
        .query({
          query: `SELECT VALUE COUNT(1) FROM c WHERE c.${C.DOCUMENT_TYPE} = @dt`,
          parameters: [{ name: '@dt', value: C.DOCUMENT_TYPE_VALUE }],
        })
        .fetchAll();
      const logCount = Array.isArray(resources) ? Number(resources[0] ?? 0) : 0;
      return {
        ok: true,
        detail: `Connected to ${this.dbName} · ${orgs.length} organizations · ${logCount} time-log records.`,
      };
    } catch (e: any) {
      return { ok: false, detail: `Cosmos query failed: ${e?.message ?? String(e)}` };
    }
  }

  // ── listOrganizations ──────────────────────────────────────────────────────
  // Returns active customer_tenant entries for the DynamicsOps company.
  // SECURITY: projection excludes pat/pat_secret/client_secret/endpoint_url.
  async listOrganizations(): Promise<CosmosOrg[]> {
    if (this.mockMode) return MOCK_ORGS;
    const C = COSMOS_MAP.CUSTOMER;
    const q = {
      query: `SELECT c.id, c.${C.ORG_NAME}, c.${C.DISPLAY_NAME}, c.${C.COMPANY_ID}
              FROM c
              WHERE c.${C.STATUS} = @status AND c.${C.TYPE} = @type`,
      parameters: [
        { name: '@status', value: C.STATUS_ACTIVE },
        { name: '@type', value: C.TYPE_CUSTOMER },
      ],
    };
    try {
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.CUSTOMERS).items
        .query(q)
        .fetchAll();
      return (resources as any[]).map((r) => ({
        id: r.id,
        org_name: r[C.ORG_NAME] ?? '',
        display_name: r[C.DISPLAY_NAME] ?? r[C.ORG_NAME] ?? '',
        company_id: r[C.COMPANY_ID],
      }));
    } catch (e) {
      this.logger.error('listOrganizations failed', e);
      return [];
    }
  }

  // ── listProjects ───────────────────────────────────────────────────────────
  async listProjects(org: string): Promise<string[]> {
    if (this.mockMode) {
      const seen = new Set<string>();
      MOCK_TIME_LOGS.filter((t) => t.org === org).forEach((t) => seen.add(t.project));
      return [...seen].sort();
    }
    const C = COSMOS_MAP.TIME_LOG;
    const q = {
      query: `SELECT DISTINCT VALUE c.${C.PROJECT} FROM c
              WHERE c.${C.ORG} = @org AND c.${C.DOCUMENT_TYPE} = @dt`,
      parameters: [
        { name: '@org', value: org },
        { name: '@dt', value: C.DOCUMENT_TYPE_VALUE },
      ],
    };
    try {
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.TIME_LOGS).items
        .query(q)
        .fetchAll();
      return (resources as string[]).filter(Boolean).sort();
    } catch (e) {
      this.logger.error('listProjects failed', e);
      return [];
    }
  }

  // ── fetchTimelogs ──────────────────────────────────────────────────────────
  async fetchTimelogs(opts: {
    org: string; // org_name — the populated key in core_time_logs (customer_id is empty there)
    project?: string;
    fromMs: number;
    toMs: number;
  }): Promise<CosmosTimelog[]> {
    if (this.mockMode) {
      return MOCK_TIME_LOGS.filter((t) => {
        if (t.org !== opts.org) return false;
        if (opts.project && t.project !== opts.project) return false;
        if (t.dateMs < opts.fromMs || t.dateMs > opts.toMs) return false;
        return true;
      });
    }
    const C = COSMOS_MAP.TIME_LOG;
    // start_time is a numeric epoch-ms field → numeric bounds (NOT strings).
    const params: { name: string; value: any }[] = [
      { name: '@org', value: opts.org },
      { name: '@from', value: opts.fromMs },
      { name: '@to', value: opts.toMs },
      { name: '@dt', value: C.DOCUMENT_TYPE_VALUE },
    ];
    let projectClause = '';
    if (opts.project) {
      projectClause = ` AND c.${C.PROJECT} = @proj`;
      params.push({ name: '@proj', value: opts.project });
    }
    const q = {
      query: `SELECT * FROM c
              WHERE c.${C.ORG} = @org
                AND c.${C.DOCUMENT_TYPE} = @dt
                AND c.${C.DATE_MS} >= @from
                AND c.${C.DATE_MS} <= @to${projectClause}`,
      parameters: params,
    };
    try {
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.TIME_LOGS).items
        .query(q)
        .fetchAll();
      return (resources as any[]).map((r) => this.mapTimelog(r));
    } catch (e) {
      this.logger.error('fetchTimelogs failed', e);
      return [];
    }
  }

  private mapTimelog(r: any): CosmosTimelog {
    const C = COSMOS_MAP.TIME_LOG;
    return {
      id: r.id,
      hours: Number(r[C.HOURS] ?? 0),
      userId: String(r[C.USER_ID] ?? ''),
      workItemId: String(r[C.TASK_ID] ?? r[C.TASK_ID_FALLBACK] ?? ''),
      title: String(r[C.TITLE] ?? ''),
      dateMs: Number(r[C.DATE_MS] ?? 0),
      dateStr: r[C.DATE_STR] ?? undefined,
      workType: r[C.WORK_TYPE] ?? undefined,
      comment: r[C.COMMENT] ?? undefined,
      project: String(r[C.PROJECT] ?? ''),
      org: r[C.ORG] ?? undefined,
      customerId: r[C.CUSTOMER_ID] ?? undefined,
      isSent: r[C.IS_SENT] ?? false,
      isOnsite: r[C.IS_ONSITE] ?? false,
    };
  }

  // ── fetchTasks ─────────────────────────────────────────────────────────────
  async fetchTasks(opts: { org: string; project?: string }): Promise<CosmosTask[]> {
    if (this.mockMode) {
      let tasks = MOCK_TASKS;
      if (opts.project) tasks = tasks.filter((t) => t.project === opts.project);
      return tasks;
    }
    const C = COSMOS_MAP.DEVOPS_TASK;
    const params: { name: string; value: any }[] = [
      { name: '@org', value: opts.org },
      { name: '@dt', value: C.DOC_TYPE_VALUE },
    ];
    let projectClause = '';
    if (opts.project) {
      projectClause = ` AND c.${C.PROJECT} = @proj`;
      params.push({ name: '@proj', value: opts.project });
    }
    const q = {
      query: `SELECT * FROM c
              WHERE c.${C.ORG} = @org
                AND c.${C.DOC_TYPE} = @dt${projectClause}`,
      parameters: params,
    };
    try {
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.DEVOPS_TASKS).items
        .query(q)
        .fetchAll();
      return (resources as any[]).map((r) => this.mapTask(r));
    } catch (e) {
      this.logger.error('fetchTasks failed', e);
      return [];
    }
  }

  private mapTask(r: any): CosmosTask {
    const C = COSMOS_MAP.DEVOPS_TASK;
    return {
      workItemId: String(r[C.WORK_ITEM_ID] ?? r.id ?? ''),
      title: String(r[C.TITLE] ?? ''),
      originalEstimate: Number(r[C.ORIGINAL_ESTIMATE] ?? 0),
      completedWork: Number(r[C.COMPLETED_WORK] ?? 0),
      logged: Number(r[C.LOGGED] ?? 0),
      type: r[C.TYPE] ?? undefined,
      state: r[C.STATE] ?? undefined,
      assignee: r[C.ASSIGNEE] ?? undefined,
      priority: r[C.PRIORITY] != null ? Number(r[C.PRIORITY]) : undefined,
      workItemType: r[C.TYPE] ?? undefined,
      updatedAt: r[C.UPDATED_AT] ?? undefined,
      changedAt: r[C.CHANGED_AT] ?? undefined,
      createdAt: r[C.CREATED_AT] ?? undefined,
      project: String(r[C.PROJECT] ?? ''),
      org: r[C.ORG] ?? undefined,
      customerId: r[C.CUSTOMER_ID] ?? undefined,
    };
  }

  // ── fetchProjectTasks ──────────────────────────────────────────────────────
  // DevOps work items for a single project (used by the project status report).
  // Reuses mapTask + COSMOS_MAP. Mock mode returns MOCK_TASKS filtered by project.
  async fetchProjectTasks(opts: { org: string; project: string }): Promise<CosmosTask[]> {
    if (this.mockMode) {
      return MOCK_TASKS.filter((t) => t.project === opts.project);
    }
    const C = COSMOS_MAP.DEVOPS_TASK;
    const q = {
      query: `SELECT * FROM c
              WHERE c.${C.ORG} = @org
                AND c.${C.DOC_TYPE} = @dt
                AND c.${C.PROJECT} = @proj`,
      parameters: [
        { name: '@org', value: opts.org },
        { name: '@dt', value: C.DOC_TYPE_VALUE },
        { name: '@proj', value: opts.project },
      ],
    };
    try {
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.DEVOPS_TASKS).items
        .query(q)
        .fetchAll();
      return (resources as any[]).map((r) => this.mapTask(r));
    } catch (e) {
      this.logger.error('fetchProjectTasks failed', e);
      return [];
    }
  }

  // ── resolveUserNames ───────────────────────────────────────────────────────
  // Resolves user_id → display name from core_users. Some timelogs reference
  // users that no longer exist in core_users (departed/external). For those we
  // return a friendly, GUID-free label so customer-facing reports never leak
  // raw GUIDs, while staying distinct per user (short suffix) for grouping.
  private fallbackUserLabel(id: string): string {
    const short = (id || '').replace(/-/g, '').slice(0, 6);
    return short ? `Kaynak (${short})` : 'Bilinmeyen Kaynak';
  }

  async resolveUserNames(userIds: string[]): Promise<Record<string, string>> {
    if (this.mockMode) {
      const map: Record<string, string> = {};
      for (const id of userIds) map[id] = MOCK_USERS[id] ?? this.fallbackUserLabel(id);
      return map;
    }
    if (!userIds.length) return {};
    const C = COSMOS_MAP.USER;
    const paramList = userIds.map((_, i) => `@id${i}`).join(', ');
    const params = userIds.map((id, i) => ({ name: `@id${i}`, value: id }));
    const q = {
      query: `SELECT c.${C.ID}, c.${C.NAME} FROM c WHERE c.${C.ID} IN (${paramList})`,
      parameters: params,
    };
    try {
      const { resources } = await this.container(COSMOS_MAP.CONTAINERS.USERS).items
        .query(q)
        .fetchAll();
      const map: Record<string, string> = {};
      for (const id of userIds) map[id] = this.fallbackUserLabel(id); // default: friendly label
      for (const r of resources as any[]) {
        if (r[C.ID] && r[C.NAME]) map[r[C.ID]] = r[C.NAME];
      }
      return map;
    } catch (e) {
      this.logger.error('resolveUserNames failed', e);
      const map: Record<string, string> = {};
      for (const id of userIds) map[id] = this.fallbackUserLabel(id);
      return map;
    }
  }
}
