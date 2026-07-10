// Codex reasoning summary items intentionally end with an empty HTML comment
// (`<!-- -->`) so Markdown renderers keep adjacent summary blocks separate.
// BAT used to display thinking in a raw <pre>, which exposed both that sentinel
// and Markdown emphasis markers. Normalize only the exact empty comment here;
// non-empty comments remain untouched.
export function normalizeReasoningSummary(text: string): string {
  return String(text || '')
    .replace(/<!--\s*-->/g, '\n\n')
    .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
    .trim()
}
