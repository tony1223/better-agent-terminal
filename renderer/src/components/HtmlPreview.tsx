/** Renders a local .html file as a page instead of as source.
 *
 * `sandbox=""` is the empty allow-list, which is the whole point: no
 * allow-scripts (the file's JS never runs), no allow-same-origin (it gets an
 * opaque origin and cannot touch the app's DOM, storage or IPC bridge), no
 * forms, popups or top-level navigation. A .html file the agent just wrote is
 * untrusted input, and previewing it must not be a way to execute it.
 *
 * The cost of that: relative <link>/<img>/<script> URLs cannot resolve against
 * an opaque origin, so a page that depends on sibling assets renders unstyled.
 * The Source toggle is the escape hatch when the render looks wrong.
 */
export function HtmlPreview({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      className="html-preview-frame"
      sandbox=""
      srcDoc={html}
      title={`HTML preview: ${title}`}
    />
  )
}
