/**
 * TUI session-init picker.
 *
 * Renders the proxy's `ask_followup_question` form as a Pi-native menu (one
 * menu per question, in order) via `ctx.ui.custom`. Pure UI — no proxy
 * knowledge. Modeled on pi's `examples/extensions/question.ts`.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionInitForm } from "./form.js";

/**
 * Render one menu per question in `form`, in order. Returns the user's
 * selections, or `null` if the user cancelled (Esc) or running non-TUI.
 */
export async function renderSessionInitPicker(
  ctx: ExtensionContext,
  form: SessionInitForm,
): Promise<{ id: string; answer: string }[] | null> {
  if (ctx.mode !== "tui") return null;
  const answers: { id: string; answer: string }[] = [];
  for (const q of form.questions) {
    if (q.options.length === 0) return null;
    const picked = await ctx.ui.custom<{ id: string; answer: string } | null>(
      (tui, theme, _kb, done) => {
        let idx = 0;
        const refresh = () => tui.requestRender();
        function handleInput(data: string) {
          if (matchesKey(data, Key.up)) {
            idx = Math.max(0, idx - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            idx = Math.min(q.options.length - 1, idx + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            done({ id: q.id, answer: q.options[idx] });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done(null);
            return;
          }
        }
        function render(width: number): string[] {
          const lines: string[] = [];
          const w = Math.max(1, width);
          lines.push(theme.fg("accent", "─".repeat(w)));
          lines.push(theme.fg("text", q.question));
          lines.push("");
          for (let i = 0; i < q.options.length; i++) {
            const sel = i === idx;
            const prefix = sel ? theme.fg("accent", "> ") : "  ";
            lines.push(`${prefix}${i + 1}. ${q.options[i]}`);
          }
          lines.push("");
          lines.push(theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel"));
          return lines;
        }
        return { render, invalidate: () => {}, handleInput };
      },
    );
    if (picked === null) return null;
    answers.push(picked);
  }
  return answers;
}
