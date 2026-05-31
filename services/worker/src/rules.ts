// Workflow rule evaluation. Conditions are small boolean trees:
//   { all: [leaf...] } | { any: [leaf...] }   leaf = { field, op, value }
// Fields read from a flat record (the activity for pre_agent; agent_result.* for post_agent).

type Leaf = { field: string; op: string; value?: unknown };
type Condition = { all?: Leaf[]; any?: Leaf[] };

function getField(record: Record<string, any>, field: string): unknown {
  return field.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), record);
}

function evalLeaf(record: Record<string, any>, leaf: Leaf): boolean {
  const actual = getField(record, leaf.field);
  switch (leaf.op) {
    case 'eq':
      return actual === leaf.value;
    case 'in':
      return Array.isArray(leaf.value) && (leaf.value as unknown[]).includes(actual);
    case 'contains':
      return typeof actual === 'string' && typeof leaf.value === 'string' && actual.toLowerCase().includes(leaf.value.toLowerCase());
    case 'matches':
      try {
        if (typeof actual !== 'string') return false;
        // Support PCRE-style inline flags like (?i) which JS RegExp lacks.
        let pattern = String(leaf.value);
        let flags = '';
        const m = pattern.match(/^\(\?([a-z]+)\)/);
        if (m) {
          flags = m[1];
          pattern = pattern.slice(m[0].length);
        }
        return new RegExp(pattern, flags).test(actual);
      } catch {
        return false;
      }
    case 'is_not_null':
      return actual !== null && actual !== undefined;
    case 'lt':
      return typeof actual === 'number' && typeof leaf.value === 'number' && actual < leaf.value;
    default:
      return false;
  }
}

export function evalCondition(record: Record<string, any>, condition: Condition | undefined): boolean {
  if (!condition) return false;
  if (condition.all) return condition.all.every((l) => evalLeaf(record, l));
  if (condition.any) return condition.any.some((l) => evalLeaf(record, l));
  return false;
}

export interface RuleRow {
  id: string;
  name: string;
  phase: string;
  priority: number;
  condition: any;
  action_type: string;
  target_resource_id: string | null;
  set_priority: string | null;
  stop_on_match: boolean;
  is_active: boolean;
}

// Evaluate pre_agent rules → first matching route_to_resource wins (priority asc).
export function matchRoutingRule(rules: RuleRow[], activityRecord: Record<string, any>): RuleRow | null {
  const sorted = rules.filter((r) => r.is_active && r.phase === 'pre_agent').sort((a, b) => a.priority - b.priority);
  for (const r of sorted) {
    if (evalCondition(activityRecord, r.condition)) {
      if (r.action_type === 'route_to_resource' && r.target_resource_id) return r;
      if (r.stop_on_match) break;
    }
  }
  return null;
}
