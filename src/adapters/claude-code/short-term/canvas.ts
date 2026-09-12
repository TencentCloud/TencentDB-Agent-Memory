import type { ShortTermRecord } from "../types.js";

function mermaidLabel(record: ShortTermRecord): string {
  const status = record.status === "error" ? "ERR" : "OK";
  const summary = record.result_summary || record.input_summary || record.tool_name;
  return `${status} ${record.tool_name}: ${summary}`
    .replace(/["<>]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 96);
}

export function renderShortTermCanvas(records: ShortTermRecord[]): string {
  const recent = records.slice(-20);
  const lines = ["flowchart TD"];
  if (recent.length === 0) {
    lines.push('  empty["No captured tool events yet"]');
    return lines.join("\n");
  }

  for (const record of recent) {
    lines.push(`  ${record.node_id}["${mermaidLabel(record)}"]`);
  }
  for (let i = 1; i < recent.length; i++) {
    lines.push(`  ${recent[i - 1]!.node_id} --> ${recent[i]!.node_id}`);
  }
  return lines.join("\n");
}
