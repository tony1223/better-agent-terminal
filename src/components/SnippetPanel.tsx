import { useState, useEffect, useCallback } from 'react'

// Snippet interface (matches backend)
type SnippetFormat = 'plaintext' | 'markdown'

interface Snippet {
    id: number
    title: string
    content: string
    format: SnippetFormat
    category?: string
    tags?: string
    isFavorite: boolean
    createdAt: number
    updatedAt: number
}

interface SnippetSidebarProps {
    isVisible: boolean
    onPasteToClipboard?: (content: string) => void
    onPasteToTerminal?: (content: string) => void
}

interface EditDialogProps {
    snippet: Snippet | null
    isNew: boolean
    onSave: (snippet: Partial<Snippet> & { title: string; content: string; format: SnippetFormat }) => void
    onClose: () => void
}

// Edit/Create Dialog Component
function EditDialog({ snippet, isNew, onSave, onClose }: Readonly<EditDialogProps>) {
    const [title, setTitle] = useState(snippet?.title || '')
    const [content, setContent] = useState(snippet?.content || '')
    const [format, setFormat] = useState<SnippetFormat>(snippet?.format || 'plaintext')

    const handleSave = () => {
        if (!title.trim() || !content.trim()) return
        onSave({ title: title.trim(), content: content.trim(), format })
        onClose()
    }

    return (
        <div className="snippet-edit-overlay" onClick={onClose}>
            <div className="snippet-edit-dialog" onClick={e => e.stopPropagation()}>
                <div className="snippet-edit-header">
                    <h3>{isNew ? 'New Snippet' : 'Edit Snippet'}</h3>
                    <button className="close-btn" onClick={onClose}>×</button>
                </div>
                <div className="snippet-edit-body">
                    <div className="form-group">
                        <label>Title</label>
                        <input
                            type="text"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="Enter snippet name..."
                            autoFocus
                        />
                    </div>
                    <div className="form-group">
                        <label>Format</label>
                        <select value={format} onChange={e => setFormat(e.target.value as SnippetFormat)}>
                            <option value="plaintext">Plaintext</option>
                            <option value="markdown">Markdown</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Content</label>
                        <textarea
                            value={content}
                            onChange={e => setContent(e.target.value)}
                            placeholder="Enter snippet content..."
                            rows={12}
                        />
                    </div>
                </div>
                <div className="snippet-edit-footer">
                    <button className="btn-secondary" onClick={onClose}>Cancel</button>
                    <button
                        className="btn-primary"
                        onClick={handleSave}
                        disabled={!title.trim() || !content.trim()}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}

export function SnippetSidebar({ isVisible, onPasteToClipboard, onPasteToTerminal }: Readonly<SnippetSidebarProps>) {
    const [snippets, setSnippets] = useState<Snippet[]>([])
    const [searchQuery, setSearchQuery] = useState('')
    const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    // Double-click behavior: 'clipboard', 'terminal', or 'edit'
    const [doubleClickAction, setDoubleClickAction] = useState<'clipboard' | 'terminal' | 'edit'>('terminal')
    // Auto-execute: automatically press Enter after pasting to terminal
    const [autoExecute, setAutoExecute] = useState(true)

    const loadSnippets = useCallback(async () => {
        try {
            let data: Snippet[]
            if (searchQuery) {
                data = await window.electronAPI.snippet.search(searchQuery)
            } else {
                data = await window.electronAPI.snippet.getAll()
            }
            setSnippets(data)
        } catch (error) {
            console.error('Failed to load snippets:', error)
        }
    }, [searchQuery])

    useEffect(() => {
        if (isVisible) {
            loadSnippets()
        }
    }, [isVisible, loadSnippets])

    const handleCreate = async (data: { title: string; content: string; format: SnippetFormat }) => {
        try {
            await window.electronAPI.snippet.create(data)
            loadSnippets()
        } catch (error) {
            console.error('Failed to create snippet:', error)
        }
    }

    const handleUpdate = async (id: number, data: Partial<{ title: string; content: string; format: SnippetFormat }>) => {
        try {
            await window.electronAPI.snippet.update(id, data)
            loadSnippets()
        } catch (error) {
            console.error('Failed to update snippet:', error)
        }
    }

    const handleDelete = async (id: number) => {
        if (!confirm('Are you sure you want to delete this snippet?')) return
        try {
            await window.electronAPI.snippet.delete(id)
            loadSnippets()
        } catch (error) {
            console.error('Failed to delete snippet:', error)
        }
    }

    const handleCopyToClipboard = (content: string) => {
        if (onPasteToClipboard) {
            onPasteToClipboard(content)
        } else {
            navigator.clipboard.writeText(content)
        }
    }

    const handlePasteToTerminal = (content: string) => {
        if (onPasteToTerminal) {
            // Add carriage return to auto-execute if enabled (use \r for terminal)
            const finalContent = autoExecute ? content + '\r' : content
            onPasteToTerminal(finalContent)
        }
    }

    const handleDoubleClick = (snippet: Snippet) => {
        if (doubleClickAction === 'clipboard') {
            handleCopyToClipboard(snippet.content)
        } else if (doubleClickAction === 'terminal') {
            handlePasteToTerminal(snippet.content)
        } else {
            setEditingSnippet(snippet)
        }
    }

    if (!isVisible) return null

    return (
        <>
            <aside className="snippet-sidebar">
                <div className="snippet-sidebar-header">
                    <h3>📝 Snippets</h3>
                    <button className="snippet-add-btn" onClick={() => setIsCreating(true)} title="New Snippet">
                        +
                    </button>
                </div>

                <div className="snippet-sidebar-search">
                    <input
                        type="text"
                        placeholder="Search snippets..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                    />
                </div>

                <div className="snippet-sidebar-options">
                    <label>Double-click:</label>
                    <select
                        value={doubleClickAction}
                        onChange={e => setDoubleClickAction(e.target.value as 'clipboard' | 'terminal' | 'edit')}
                    >
                        <option value="terminal">Paste to Terminal</option>
                        <option value="clipboard">Copy to Clipboard</option>
                        <option value="edit">Open Editor</option>
                    </select>
                </div>

                <div className="snippet-sidebar-options">
                    <label>Auto-execute:</label>
                    <input
                        type="checkbox"
                        checked={autoExecute}
                        onChange={e => setAutoExecute(e.target.checked)}
                        title="Automatically press Enter after pasting to terminal"
                    />
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                        (press Enter)
                    </span>
                </div>

                <div className="snippet-sidebar-list">
                    {snippets.length === 0 ? (
                        <div className="snippet-empty">
                            {searchQuery ? 'No matching snippets' : 'No snippets yet. Click + to add one.'}
                        </div>
                    ) : (
                        snippets.map(snippet => (
                            <div
                                key={snippet.id}
                                className={`snippet-sidebar-item ${searchQuery ? 'search-match' : ''}`}
                                onDoubleClick={() => handleDoubleClick(snippet)}
                            >
                                <div className="snippet-item-main">
                                    <span className="snippet-item-title">{snippet.title}</span>
                                    <span className={`snippet-item-format ${snippet.format}`}>
                                        {snippet.format === 'markdown' ? 'MD' : 'Text'}
                                    </span>
                                </div>
                                <div className="snippet-item-preview">
                                    {snippet.content.substring(0, 50)}
                                    {snippet.content.length > 50 ? '...' : ''}
                                </div>
                                <div className="snippet-item-actions">
                                    <button
                                        className="snippet-action-btn"
                                        onClick={() => handlePasteToTerminal(snippet.content)}
                                        title="Paste to Terminal"
                                    >
                                        ▶️
                                    </button>
                                    <button
                                        className="snippet-action-btn"
                                        onClick={() => handleCopyToClipboard(snippet.content)}
                                        title="Copy to Clipboard"
                                    >
                                        📋
                                    </button>
                                    <button
                                        className="snippet-action-btn"
                                        onClick={() => setEditingSnippet(snippet)}
                                        title="Edit"
                                    >
                                        ✏️
                                    </button>
                                    <button
                                        className="snippet-action-btn danger"
                                        onClick={() => handleDelete(snippet.id)}
                                        title="Delete"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </aside>

            {/* Edit Dialog */}
            {(editingSnippet || isCreating) && (
                <EditDialog
                    snippet={editingSnippet}
                    isNew={isCreating}
                    onSave={(data) => {
                        if (isCreating) {
                            handleCreate(data)
                            setIsCreating(false)
                        } else if (editingSnippet) {
                            handleUpdate(editingSnippet.id, data)
                            setEditingSnippet(null)
                        }
                    }}
                    onClose={() => {
                        setEditingSnippet(null)
                        setIsCreating(false)
                    }}
                />
            )}
        </>
    )
}
