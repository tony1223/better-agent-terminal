import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// Snippet interface
export type SnippetFormat = 'plaintext' | 'markdown'

export interface Snippet {
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

export interface CreateSnippetInput {
    title: string
    content: string
    format?: SnippetFormat
    category?: string
    tags?: string
    isFavorite?: boolean
}

interface SnippetData {
    snippets: Snippet[]
    nextId: number
}

class SnippetDatabase {
    private readonly dataPath: string
    private data: SnippetData = { snippets: [], nextId: 1 }

    constructor() {
        const userDataPath = app.getPath('userData')
        this.dataPath = path.join(userDataPath, 'snippets.json')
        this.load()
    }

    private load() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const raw = fs.readFileSync(this.dataPath, 'utf-8')
                this.data = JSON.parse(raw)
            }
        } catch (error) {
            console.error('Failed to load snippets:', error)
            this.data = { snippets: [], nextId: 1 }
        }
    }

    private save() {
        try {
            const dir = path.dirname(this.dataPath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8')
        } catch (error) {
            console.error('Failed to save snippets:', error)
        }
    }

    create(input: CreateSnippetInput): Snippet {
        const now = Date.now()
        const snippet: Snippet = {
            id: this.data.nextId++,
            title: input.title,
            content: input.content,
            format: input.format || 'plaintext',
            category: input.category,
            tags: input.tags,
            isFavorite: input.isFavorite || false,
            createdAt: now,
            updatedAt: now
        }
        this.data.snippets.push(snippet)
        this.save()
        return snippet
    }

    getById(id: number): Snippet | null {
        return this.data.snippets.find(s => s.id === id) || null
    }

    getAll(): Snippet[] {
        return [...this.data.snippets].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    getFavorites(): Snippet[] {
        return this.data.snippets
            .filter(s => s.isFavorite)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    getByCategory(category: string): Snippet[] {
        return this.data.snippets
            .filter(s => s.category === category)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    search(query: string): Snippet[] {
        const term = query.toLowerCase()
        return this.data.snippets
            .filter(s =>
                s.title.toLowerCase().includes(term) ||
                s.content.toLowerCase().includes(term) ||
                (s.tags && s.tags.toLowerCase().includes(term))
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    update(id: number, updates: Partial<CreateSnippetInput>): Snippet | null {
        const index = this.data.snippets.findIndex(s => s.id === id)
        if (index === -1) return null

        const existing = this.data.snippets[index]
        const updated: Snippet = {
            ...existing,
            title: updates.title ?? existing.title,
            content: updates.content ?? existing.content,
            format: updates.format ?? existing.format,
            category: updates.category ?? existing.category,
            tags: updates.tags ?? existing.tags,
            isFavorite: updates.isFavorite ?? existing.isFavorite,
            updatedAt: Date.now()
        }
        this.data.snippets[index] = updated
        this.save()
        return updated
    }

    delete(id: number): boolean {
        const index = this.data.snippets.findIndex(s => s.id === id)
        if (index === -1) return false
        this.data.snippets.splice(index, 1)
        this.save()
        return true
    }

    toggleFavorite(id: number): Snippet | null {
        const snippet = this.getById(id)
        if (!snippet) return null
        return this.update(id, { isFavorite: !snippet.isFavorite })
    }

    getCategories(): string[] {
        const categories = new Set<string>()
        for (const s of this.data.snippets) {
            if (s.category) categories.add(s.category)
        }
        return Array.from(categories).sort()
    }

    close() {
        // No-op for JSON storage
    }
}

export const snippetDb = new SnippetDatabase()
