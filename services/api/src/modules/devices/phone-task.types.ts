// Step-script vocabulary for the phone operator. Server-authored only: the
// Android AccessibilityService executes this verbatim and never replans.
export type PhoneStep =
  | { op: 'open_app'; package_name: string }
  | { op: 'tap'; selector: PhoneSelector; timeout_ms?: number }
  | { op: 'type'; selector: PhoneSelector; value: string; timeout_ms?: number }
  | { op: 'wait'; ms: number }
  | { op: 'assert'; selector: PhoneSelector; expect: 'present' | 'absent'; timeout_ms?: number };

export interface PhoneSelector {
  text?: string;
  content_desc?: string;
  resource_id?: string;
}

export interface PhoneStepResult {
  index: number;
  op: PhoneStep['op'];
  ok: boolean;
  detail?: string;
  duration_ms?: number;
}

export interface PhoneTaskResult {
  ok: boolean;
  steps: PhoneStepResult[];
  failed_at_index?: number;
}
