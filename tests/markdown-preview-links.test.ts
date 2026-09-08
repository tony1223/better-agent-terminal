import assert from 'node:assert/strict'
import { markdownHeadingId, resolveMarkdownPreviewHref } from '../renderer/src/utils/markdown-preview-links'
import { openChatMarkdownLink } from '../renderer/src/utils/chat-markdown'

const source = 'C:\\workspaces\\game_bbo\\plans\\game_reconstruction_master_plan.md'
const resolve = (href: string, filePath = source) => resolveMarkdownPreviewHref(href, filePath)
assert.equal(resolve('batch03.md'), 'file:///C:/workspaces/game_bbo/plans/batch03.md')
assert.equal(resolve('../research/batch03.md'), 'file:///C:/workspaces/game_bbo/research/batch03.md')
assert.equal(resolve('..\\research\\batch03.md'), 'file:///C:/workspaces/game_bbo/research/batch03.md')
assert.equal(resolve('../research/speed%20rules.md#results'), 'file:///C:/workspaces/game_bbo/research/speed%20rules.md#results')
assert.equal(resolve('C:/other/report.md'), 'file:///C:/other/report.md')
assert.equal(resolve('D:\\other\\report.md'), 'file:///D:/other/report.md')
assert.equal(resolve('file:///D:/other/report.md'), 'file:///D:/other/report.md')
assert.equal(resolve('/srv/report.md', '/home/user/plans/master.md'), 'file:///srv/report.md')
assert.equal(resolve('../report.md', '/home/user/plans/master.md'), 'file:///home/user/report.md')
assert.equal(resolve('../report.md', '\\\\server\\share\\plans\\master.md'), 'file://server/share/report.md')
assert.equal(resolve('\\\\server\\share\\report.md'), 'file://server/share/report.md')
assert.equal(resolve('next.md', 'C:\\repo #1\\100%\\master.md'), 'file:///C:/repo%20%231/100%25/next.md')
assert.equal(resolve('report%23one.md'), 'file:///C:/workspaces/game_bbo/plans/report%23one.md')
assert.equal(resolve('100%.md'), 'file:///C:/workspaces/game_bbo/plans/100%25.md')
assert.equal(resolve('../src/game.ts:12:3'), 'file:///C:/workspaces/game_bbo/src/game.ts#line=12&column=3')
assert.equal(resolve('#目前研究順序'), '#目前研究順序')
assert.equal(resolve('./game_reconstruction_master_plan.md#results'), '#results')
assert.equal(resolve('https://example.com/report?q=1#results'), 'https://example.com/report?q=1#results')
assert.equal(resolve('//example.com/report'), 'https://example.com/report')
assert.equal(resolve('mailto:reader@example.com'), 'mailto:reader@example.com')
for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'tauri://localhost/report', '']) {
  assert.equal(resolve(href), null)
}
assert.equal(resolve('next.md', ''), null, 'missing host path must not fall back to the WebView origin')
assert.equal(markdownHeadingId('目前研究順序'), '目前研究順序')
assert.equal(markdownHeadingId('Speed & Results'), 'speed--results')

// Exercise the actual preview dispatch, including a remote Windows host path.
// The same host.fs preview route is used locally and in a remote profile.
const events: CustomEvent[] = []
const externalUrls: string[] = []
;(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args?: { url?: string }) => {
      if (command === 'shell_open_external') externalUrls.push(args!.url!)
      return false
    },
  },
  dispatchEvent: (event: CustomEvent) => { events.push(event); return true },
}
openChatMarkdownLink(resolve('../research/speed%20rules.md#results')!)
assert.equal(events[0].type, 'preview-markdown')
assert.equal(events[0].detail.path, 'C:/workspaces/game_bbo/research/speed rules.md')
assert.equal(events[0].detail.fragment, '#results')
openChatMarkdownLink(resolve('../src/game.ts:12:3')!)
assert.equal(events[1].type, 'preview-file')
assert.equal(events[1].detail.path, 'C:/workspaces/game_bbo/src/game.ts')
assert.equal(events[1].detail.line, 12)
assert.equal(events[1].detail.column, 3)
openChatMarkdownLink(resolve('\\\\server\\share\\report.md')!)
assert.equal(events[2].detail.path, '//server/share/report.md')
assert.deepEqual(externalUrls, [], 'file links must stay in the host preview flow')
openChatMarkdownLink(resolve('https://example.com/report')!)
assert.deepEqual(externalUrls, ['https://example.com/report'])

console.log('markdown-preview-links: passed')
