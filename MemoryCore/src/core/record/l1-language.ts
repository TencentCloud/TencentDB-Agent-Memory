export type ContentLanguage = "zh" | "ja" | "ko" | "en" | "unknown";

/** Script-based label for the stored L1 text. Latin-dominant text uses the English bucket. */
export function detectContentLanguage(content: string): ContentLanguage {
  const letters = content.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return "unknown";

  const cjk = content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  if (cjk > letters * 0.2) {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(content)) return "ja";
    if (/\p{Script=Hangul}/u.test(content)) return "ko";
    return "zh";
  }
  const latin = content.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin >= letters * 0.8 ? "en" : "unknown";
}
