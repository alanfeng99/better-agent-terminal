import { host } from '../host-api'
import { useEffect, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'

marked.setOptions({
  gfm: true,
  breaks: false,
})

const renderer = new marked.Renderer()

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  if (lang === 'mermaid') {
    return `<div class="mermaid">${text}</div>`
  }
  let highlighted: string
  try {
    highlighted = lang
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value
  } catch {
    highlighted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlighted}</code></pre>`
}

renderer.link = function ({ href, text }: { href: string; text: string }) {
  return `<a href="${href}" data-external-link="true">${text}</a>`
}

renderer.image = function ({ href, text }: { href: string; text: string }) {
  const src = href.startsWith('/') ? `file://${href}` : href
  return `<img alt="${text || ''}" src="${src}" style="max-width:100%"/>`
}

marked.use({ renderer })

function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text) as string
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['checked', 'disabled', 'type', 'data-external-link'],
  })
}

let mermaidInstance: typeof import('mermaid')['default'] | null = null

async function getMermaid() {
  if (!mermaidInstance) {
    mermaidInstance = (await import('mermaid')).default
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#1e1e1e',
        primaryColor: '#3498db',
        primaryTextColor: '#e0e0e0',
        lineColor: '#666',
      },
    })
  }
  return mermaidInstance
}

async function renderMermaidBlocks(container: HTMLElement) {
  const mermaidDivs = container.querySelectorAll('.mermaid')
  if (mermaidDivs.length === 0) return

  const mermaid = await getMermaid()
  mermaidDivs.forEach((div, i) => {
    div.id = `mermaid-${Date.now()}-${i}`
  })
  try {
    await mermaid.run({ nodes: mermaidDivs as unknown as ArrayLike<HTMLElement> })
  } catch {
    mermaidDivs.forEach(div => {
      if (!div.querySelector('svg')) {
        div.classList.add('mermaid-error')
      }
    })
  }
}

export function MarkdownPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const html = renderMarkdown(content)

  useEffect(() => {
    if (containerRef.current) {
      renderMermaidBlocks(containerRef.current)
    }
  }, [html])

  return (
    <div
      ref={containerRef}
      className="file-preview-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = e.target as HTMLElement
        const link = target.closest('a[data-external-link]') as HTMLAnchorElement | null
        if (link) {
          e.preventDefault()
          host.shell.openExternal(link.href)
        }
      }}
    />
  )
}
