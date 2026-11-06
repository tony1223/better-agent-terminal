import assert from 'node:assert/strict'
import { markdownHeadingId, resolveChatMarkdownHref, resolveMarkdownPreviewHref } from '../renderer/src/utils/markdown-preview-links'
import { Marked } from 'marked'
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

const chinesePath = 'D:/ACG拆解重構兔子洞/_tmp/README.md'
const chatCwd = 'C:/workspaces/project'
const chatParser = new Marked({ walkTokens(token) {
  if (token.type === 'link') token.href = resolveChatMarkdownHref(token.href, chatCwd) ?? token.href
} })
for (const destination of [chinesePath, `<${chinesePath}>`, encodeURI(chinesePath)]) {
  const html = chatParser.parse(`[x](${destination})`) as string
  const href = html.match(/href="([^"]+)"/)![1]
  assert.ok(!href.includes('%25E'), 'Chinese characters must not be encoded twice')
  openChatMarkdownLink(href)
  assert.equal(events.at(-1)!.type, 'preview-markdown')
  assert.equal(events.at(-1)!.detail.path, chinesePath)
}
for (const [href, cwd, path] of [
  [chinesePath, '', chinesePath],
  [encodeURI(chinesePath), '/remote/workspace', chinesePath],
  ['../中文/README.md', 'C:/workspaces/project', 'C:/workspaces/中文/README.md'],
  ['read%20me.md', 'D:/中文目錄', 'D:/中文目錄/read me.md'],
  ['D:/中文/100%25/%2520.md', chatCwd, 'D:/中文/100%/%20.md'],
  ['report%23one.md', 'D:/中文 #1/100%', 'D:/中文 #1/100%/report#one.md'],
  ['C:/Users/noveltsai/.claude/CLAUDE.md', chatCwd, 'C:/Users/noveltsai/.claude/CLAUDE.md'],
  ['\\\\server\\share\\中文\\README.md', chatCwd, '//server/share/中文/README.md'],
] as const) {
  const resolved = resolveChatMarkdownHref(href, cwd)!
  openChatMarkdownLink(resolved)
  assert.equal(events.at(-1)!.detail.path, path)
}
openChatMarkdownLink(resolveChatMarkdownHref(chinesePath + '#使用說明', chatCwd)!)
assert.equal(events.at(-1)!.detail.path, chinesePath)
assert.equal(decodeURIComponent(events.at(-1)!.detail.fragment), '#使用說明')
openChatMarkdownLink(resolveChatMarkdownHref('D:/中文/檔案.ts:12:3', chatCwd)!)
assert.equal(events.at(-1)!.detail.path, 'D:/中文/檔案.ts')
assert.equal(events.at(-1)!.detail.line, 12)
assert.equal(events.at(-1)!.detail.column, 3)
assert.equal(resolveChatMarkdownHref('relative.md', ''), null)
for (const invalid of ['javascript:alert(1)', 'data:text/html,hello', 'tauri://localhost/report']) {
  assert.equal(resolveChatMarkdownHref(invalid, chatCwd), null)
}
assert.deepEqual(externalUrls, ['https://example.com/report'], 'local links must not use external shell opening')

console.log('markdown-preview-links: passed')
