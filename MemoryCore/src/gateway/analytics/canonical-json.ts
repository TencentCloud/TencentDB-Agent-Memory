/**
 * Canonical JSON identical to Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))` — used for
 * stable watermark hashing shared with check-recall-telemetry.py.
 *
 *  - object keys sorted recursively (Python sorts str keys by Unicode code
 *    point; UTF-16 code-unit order matches for BMP chars)
 *  - compact separators "," and ":"
 *  - non-ASCII escaped as \uXXXX (lowercase hex, surrogate pairs as two
 *    escapes — Python's default ensure_ascii=True)
 *  - numbers/booleans/null via JSON.stringify (Python-compatible for
 *    finite numbers; NaN/Infinity are not produced upstream)
 */

function escStr(s: string): string {
  const json = JSON.stringify(s);
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : json[i];
  }
  return out;
}

export function pythonCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return escStr(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => pythonCanonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined || typeof v === "function") continue;
      parts.push(`${escStr(key)}:${pythonCanonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}
