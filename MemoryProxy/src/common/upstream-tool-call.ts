export interface UpstreamToolCall {
  /**
   * The id the *next* request will reference this call by — `tool_use.id` /
   * `tool_calls[].id`, and for Responses the `call_id`, never the item `id`.
   * A follow-up turn pairs its tool result on this value alone.
   */
  id: string;
  name: string;
  /** Raw, unparsed argument JSON exactly as the upstream emitted it. */
  arguments: string;
}
