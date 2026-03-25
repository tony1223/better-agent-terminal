import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { settingsStore } from '../stores/settings-store'

interface PromptBoxProps {
  terminalId: string
}

// Per-terminal history stored in memory
const historyMap = new Map<string, string[]>()

export function PromptBox({ terminalId }: Readonly<PromptBoxProps>) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [fontFamily, setFontFamily] = useState(settingsStore.getFontFamilyString())
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const unsubscribe = settingsStore.subscribe(() => {
      setFontFamily(settingsStore.getFontFamilyString())
    })
    return unsubscribe
  }, [])

  const getHistory = () => historyMap.get(terminalId) || []

  const handleSend = async () => {
    const content = text.trim()
    if (!content && !imagePath) return

    // Save to history
    if (content) {
      const history = getHistory()
      // Avoid consecutive duplicates
      if (history[history.length - 1] !== content) {
        history.push(content)
        historyMap.set(terminalId, history)
      }
    }
    setHistoryIndex(-1)
    draftRef.current = ''

    // Order: text first (no Enter) → attach image → Enter to submit
    if (content) {
      await window.electronAPI.pty.write(terminalId, content)
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (imagePath) {
      await window.electronAPI.clipboard.writeImage(imagePath)
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.electronAPI.pty.write(terminalId, '\x1bv')
      await new Promise(resolve => setTimeout(resolve, 800))
    }

    await window.electronAPI.pty.write(terminalId, '\r')

    setText('')
    setImagePath(null)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      textareaRef.current?.blur()
      return
    }

    const history = getHistory()
    if (history.length === 0) return

    const textarea = textareaRef.current
    const isMultiLine = text.includes('\n')

    // Up arrow: navigate history only when single-line or already browsing history
    if (e.key === 'ArrowUp') {
      if (isMultiLine && historyIndex === -1) return // let textarea handle cursor movement
      if (textarea && textarea.selectionStart !== 0) return

      e.preventDefault()
      if (historyIndex === -1) {
        draftRef.current = text
      }
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(newIndex)
      setText(history[newIndex])
      return
    }

    // Down arrow: navigate history only when single-line or already browsing history
    if (e.key === 'ArrowDown') {
      if (isMultiLine && historyIndex === -1) return
      if (textarea && textarea.selectionStart !== textarea.value.length) return
      if (historyIndex === -1) return

      e.preventDefault()
      const newIndex = historyIndex + 1
      if (newIndex >= history.length) {
        setHistoryIndex(-1)
        setText(draftRef.current)
      } else {
        setHistoryIndex(newIndex)
        setText(history[newIndex])
      }
      return
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    // Reset history navigation when user types
    if (historyIndex !== -1) {
      setHistoryIndex(-1)
      draftRef.current = ''
    }
    // Auto-resize textarea height
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const filePath = await window.electronAPI.clipboard.saveImage()
        if (filePath) {
          setImagePath(filePath)
        }
        return
      }
    }
  }

  const hasContent = text.trim() || imagePath

  return (
    <div className="prompt-box">
      <div className="prompt-box-inner">
        <textarea
          ref={textareaRef}
          className="prompt-box-textarea"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={imagePath ? t('promptBox.placeholderWithImage') : t('promptBox.placeholder')}
          style={{ fontFamily, overflowY: 'auto', maxHeight: 200, resize: 'none' }}
          rows={1}
        />
        <button
          className="prompt-box-send"
          onClick={handleSend}
          disabled={!hasContent}
          title={t('promptBox.sendToTerminal')}
        >
          ▶
        </button>
      </div>
      <div className="prompt-box-hint">
        {imagePath ? (
          <>
            <span className="prompt-box-image-badge">
              {t('promptBox.imageAttached')}
              <button className="prompt-box-image-remove" onClick={() => setImagePath(null)} title={t('promptBox.removeImage')}>×</button>
            </span>
            {' · '}
          </>
        ) : null}
        {t('promptBox.hint')}
      </div>
    </div>
  )
}
