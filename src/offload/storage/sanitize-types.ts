/**
 * Sanitize constant types (split from sanitize.ts to avoid circular imports
 * between ref-md.ts and sanitize.ts). The UNSAFE_CHAR_RE constant lives here;
 * sanitize.ts re-exports it for back-compat.
 */
export const UNSAFE_CHAR_RE =
  /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0080-\u009F\uD800-\uDFFF\u200B-\u200F\u2028\u2029\uFEFF]/gu;
