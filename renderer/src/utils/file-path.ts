// Paths as they appear in agent output, rather than as the filesystem wants them.

// A cited path frequently carries a "file.ts:42" or "file.ts:42:7" suffix — chat
// citations, compiler output, grep results, stack traces. fs.stat / fs.readFile /
// reveal all reject it on Windows, where ':' is not legal in a file name, so the
// suffix has to come off before the path reaches the host.
export function stripLineSuffix(p: string): { path: string; line?: number; column?: number } {
  if (!p) return { path: p }
  const m = p.match(/^(.+?\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?$/)
  if (!m) return { path: p }
  return { path: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined }
}
