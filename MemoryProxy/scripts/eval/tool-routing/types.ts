export type ToolFamily = "memory" | "skill" | "knowledge";

export interface ExpectedRoute {
  should_call: boolean;
  family?: ToolFamily;
  tools?: string[];
  /** Every listed tool must be observed (for multi-step routes such as wiki search → read_page). */
  tools_all?: string[];
  endpoints?: string[];
  body_requires?: string[];
}

export interface EvalCase {
  id: string;
  split: "dev" | "test";
  category: string;
  scenario: string;
  user: string;
  workspace_repo?: string;
  current_context?: string;
  profile_memory?: string;
  source: string;
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
  error?: string;
}

export interface RunRecord {
  case_id: string;
  split: EvalCase["split"];
  category: string;
  variant: "baseline" | "candidate";
  repetition: number;
  requested_model: string;
  actual_model?: string;
  request_config: {
    temperature: number;
    top_p: number;
    thinking_mode: string;
    extra_body?: Record<string, unknown>;
  };
  prompt_chars: number;
  prompt_bytes: number;
  prompt_sha256: string;
  prompt_tokens?: number;
  total_prompt_tokens?: number;
  completion_tokens?: number;
  calls: ParsedCall[];
  final_text?: string;
  error?: string;
}
