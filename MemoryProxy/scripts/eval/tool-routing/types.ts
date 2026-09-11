import type { RequestGuard, RequestGuardResult } from "./request-guards.js";

export type ToolFamily = "memory" | "skill" | "knowledge";

export interface EvalMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface EvalSkill {
  name: string;
  description: string;
  distractor_type?: "gold" | "cross-domain" | "semantic" | "session-carry-over";
}

export interface EvalProvenance {
  kind: "real-user" | "real-request-derived" | "human-authored-benchmark" | "synthetic-benchmark" | "synthetic-human-reviewed";
  uri: string;
  license: string;
  prompt_transformation: "verbatim" | "source-fields-verbatim" | "perspective-normalized" | "redacted" | "translated" | "synthetic";
  transformation_note?: string;
  context_origin?: "source" | "synthetic-neutral" | "none";
  /** Public release year of the source benchmark or creation year of a real-user item. */
  source_release_year?: number;
  /** Language in which the source prompt was originally authored. */
  language_origin?: "native-zh" | "translated-zh" | "native-en" | "mixed";
  /** Optional date carried by the source item; kept separate from benchmark release time. */
  source_item_date?: string;
}

export interface EvalKnowledgeResource {
  knowledge_id: string;
  type: "wiki" | "code-graph";
  service_url: string;
  name: string;
  summary?: string | null;
  team_id?: string;
  user_id?: string | null;
  repo_url?: string;
  branch?: string;
  repo_slug?: string;
  created_at?: string;
  updated_at?: string;
}

export interface EvalMockStep {
  id: string;
  family: ToolFamily;
  tool: string;
  requires?: string[];
  /** Match resource IDs/parameters as well as a tool name. Never match on variant. */
  body_match?: Record<string, unknown>;
  request_guards?: RequestGuard[];
  response: unknown;
}

export interface ExpectedRoute {
  route_policy: "required" | "forbidden" | "optional";
  /** Allow one lifecycle extraction only after observed local read/change/test validation. */
  allow_post_validation_extract?: boolean;
  /** Whether the expected cloud route must be the first actionable decision. */
  must_precede_local_action?: boolean;
  /** Ordered alternative tool sequences; any one sequence is acceptable. */
  acceptable_routes?: string[][];
  family?: ToolFamily;
  first_tools?: string[];
  tools?: string[];
  /** Every listed tool must be observed (for multi-step routes such as wiki search → read_page). */
  tools_all?: string[];
  endpoints?: string[];
  body_requires?: string[];
  arguments?: Array<{
    tool: string;
    field: string;
    one_of: Array<string | number | boolean>;
  }>;
  forbidden_families?: ToolFamily[];
  forbidden_tools?: string[];
  allowed_tools?: string[];
  allowed_families?: ToolFamily[];
  /** Closed semantic scope for every attempt, including later unrelated calls using an otherwise allowed tool. */
  allowed_arguments?: Array<{ tool: string; field: string; one_of: Array<string | number | boolean> }>;
  required_events?: Array<{
    id: string;
    any_of_tools: string[];
    family?: ToolFamily;
    endpoints?: string[];
    body_requires?: string[];
    arguments?: Array<{ field: string; one_of: Array<string | number | boolean> }>;
    after?: string[];
  }>;
  milestones?: Array<{
    id: string;
    fixture_steps?: string[];
    tools?: string[];
    after?: string[];
  }>;
}

export interface EvalCase {
  id: string;
  schema_version: 2 | 3;
  track: "core" | "stress";
  language_track: "zh-native" | "zh-adapted";
  /** Counterfactual variants share one base id and are clustered together. */
  base_scenario_id?: string;
  condition_id?: string;
  primary_condition?: boolean;
  split: "dev" | "test";
  category: string;
  scenario: string;
  messages: EvalMessage[];
  skill_menu?: EvalSkill[];
  knowledge_resources?: EvalKnowledgeResource[];
  mock_steps?: EvalMockStep[];
  max_turns?: number;
  workspace_repo?: string;
  workspace_files?: Record<string, string>;
  coding_expectation?: {
    read_paths?: string[];
    changed_paths?: string[];
    test_command?: string;
  };
  current_context?: string;
  profile_memory?: string;
  source: string;
  provenance: EvalProvenance;
  review_status: "pending" | "approved";
  expected: ExpectedRoute;
}

export interface ParsedCall {
  command: string;
  url?: string;
  endpoint?: string;
  family?: ToolFamily;
  tool?: string;
  body?: Record<string, unknown>;
  protocol_valid: boolean;
  /** Host observation at call time, never inferred from final task state or model text. */
  coding_validated_before_call?: boolean;
  /** Bound reviewer sidecar applied for scoring; absent from original host records. */
  semantic_relevance?: "relevant" | "irrelevant";
  fixture_step_id?: string;
  /** Sidecar fixture diagnostics. Never replace the raw request body with normalized matching fields. */
  fixture_guard_checks?: Array<{ step_id: string } & Omit<RequestGuardResult, "normalized_body">>;
  response_index?: number;
  action_index?: number;
  error?: string;
}

/** Actual interpreter identity, probed before a workspace run and suitable for a run manifest. */
export interface WorkspacePythonRuntime {
  executable: string;
  executable_sha256: string;
  version: string;
  version_info: [number, number, number];
  implementation: string;
  prefix: string;
  base_prefix: string;
  stdlib: string;
}

export interface RunRecord {
  case_id: string;
  base_scenario_id?: string;
  split: EvalCase["split"];
  category: string;
  variant: "baseline" | "candidate";
  repetition: number;
  requested_model: string;
  actual_model?: string;
  request_config: {
    temperature?: number;
    top_p?: number;
    thinking_mode: string;
    host?: string;
    max_responses?: number;
    max_completion_tokens?: number;
    request_timeout_ms?: number;
    initial_history_reasoning?: "preserve-or-empty-synthetic-history";
    workspace_python_runtime_sha256?: string;
    extra_body?: Record<string, unknown>;
  };
  prompt_chars: number;
  prompt_bytes: number;
  prompt_sha256: string;
  experiment_sha256?: string;
  request_sha256?: string;
  workspace_python_runtime_sha256?: string;
  termination_reason?: "final_text" | "required_events_observed" | "budget_exhausted" | "provider_error" | "invalid_response";
  window_complete?: boolean;
  history?: unknown[];
  local_actions?: Array<{ tool: string; path?: string; command?: string; success: boolean; response_index: number;
    execution?: { executable: string; argv: string[]; cwd: string; exit_code: number | null; signal: string | null;
      invoked_as?: string; python_runtime_sha256?: string;
      read_paths?: string[]; unittest?: { tests_run: number; successful: boolean } } }>;
  coding_progress?: { read: boolean; changed: boolean; tested: boolean; no_progress_or_early_abort: boolean };
  transport_attempts?: Array<{ response_index: number; attempt: number; status?: number; error?: string }>;
  usage_by_response?: Array<{ prompt_tokens?: number; completion_tokens?: number; cache_hit_tokens?: number; cache_miss_tokens?: number }>;
  prompt_tokens?: number;
  total_prompt_tokens?: number;
  completion_tokens?: number;
  first_action?: {
    kind: "cloud_tool" | "local_bash" | "text" | "invalid_tool";
    family?: ToolFamily;
    tool?: string;
  };
  calls: ParsedCall[];
  final_text?: string;
  error?: string;
}
