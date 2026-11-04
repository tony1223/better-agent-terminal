import assert from 'node:assert/strict'
import { Marked, marked } from 'marked'
import { renderMermaidCodeBlock } from '../renderer/src/utils/markdown-mermaid'

const parser = new Marked({ renderer: { code: renderMermaidCodeBlock } })

// The screenshot's Chinese subgraph, edge labels and multiline node labels.
const diagram = `flowchart LR
  subgraph W["WSFC：協調故障切換"]
    A["VM A：SQL 主要副本
自己的 VMDK"]
    B["VM B：SQL 次要副本
自己的 VMDK"]
    A -->|"AG 透過網路同步資料"| B
  end
  F["Witness 見證者<br/>參與仲裁，不存放資料庫"]
  F -.-> A
  F -.-> B`
const markdown = `前文\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n後文`
const html = parser.parse(markdown) as string
assert.ok(html.includes('<pre class="mermaid"><code class="language-mermaid">flowchart LR\n'))
assert.ok(html.includes('WSFC：協調故障切換'))
assert.ok(html.includes('主要副本\n自己的 VMDK'))
assert.ok(html.includes('Witness 見證者&lt;br/&gt;'))
assert.ok(html.includes('A --&gt;|"AG 透過網路同步資料"| B'))
assert.ok(html.includes('<p>後文</p>'))

// Streaming fences remain ordinary readable code until the fence is complete.
assert.ok(!(parser.parse('```mermaid\nflowchart LR\nA --> B') as string).includes('class="mermaid"'))
assert.ok((parser.parse('```mermaid\nflowchart LR\nA --> B\n```') as string).includes('class="mermaid"'))
assert.ok((parser.parse('~~~Mermaid\nflowchart LR\nA --> B\n~~~\n') as string).includes('class="mermaid"'))
assert.ok(!(parser.parse('````mermaid\nflowchart LR\nA --> B\n```') as string).includes('class="mermaid"'))
assert.ok((parser.parse('````mermaid\nflowchart LR\nA --> B\n`````\n') as string).includes('class="mermaid"'))

// Diagram source must not become active HTML before async rendering starts.
const escaped = parser.parse('```mermaid\nflowchart LR\nA["<img src=x onerror=alert(1)>&amp;"]\n```') as string
assert.ok(!escaped.includes('<img'))
assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;&amp;amp;'))
assert.ok((parser.parse('```ts\nconst a = "<b>"\n```') as string).includes('<pre><code class="language-ts">'))
assert.ok(!(parser.parse('`flowchart LR` is syntax, not a diagram.') as string).includes('class="mermaid"'))

// An unrelated consumer customizing the global singleton cannot change this
// isolated parser's handling of diagrams, code or surrounding Markdown.
marked.use({ renderer: { code: () => '<div>unrelated preview renderer</div>' } })
assert.equal(parser.parse(markdown), html)
assert.ok((parser.parse('| A | B |\n|---|---|\n| 1 | 2 |') as string).includes('<table>'))

console.log('chat Mermaid Markdown: passed')
