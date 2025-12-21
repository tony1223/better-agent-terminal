import { useState } from 'react'
import type { EnvVariable } from '../types'

interface EnvVarEditorProps {
    envVars: EnvVariable[]
    onAdd: (envVar: EnvVariable) => void
    onRemove: (key: string) => void
    onUpdate: (key: string, updates: Partial<EnvVariable>) => void
}

export function EnvVarEditor({ envVars, onAdd, onRemove, onUpdate }: Readonly<EnvVarEditorProps>) {
    const [newKey, setNewKey] = useState('')
    const [newValue, setNewValue] = useState('')
    const [editingKey, setEditingKey] = useState<string | null>(null)

    const handleAdd = () => {
        if (newKey.trim() && newValue.trim()) {
            // Check for duplicate key
            if (envVars.some(e => e.key === newKey.trim())) {
                alert('Environment variable name already exists')
                return
            }
            onAdd({ key: newKey.trim(), value: newValue.trim(), enabled: true })
            setNewKey('')
            setNewValue('')
        }
    }

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleAdd()
        }
    }

    return (
        <div className="env-var-editor">
            <div className="env-var-list">
                {envVars.length === 0 ? (
                    <div className="env-var-empty">
                        No environment variables configured
                    </div>
                ) : (
                    envVars.map(envVar => (
                        <div key={envVar.key} className="env-var-item">
                            <label className="env-var-toggle">
                                <input
                                    type="checkbox"
                                    checked={envVar.enabled}
                                    onChange={e => onUpdate(envVar.key, { enabled: e.target.checked })}
                                />
                            </label>
                            <div className="env-var-content">
                                {editingKey === envVar.key ? (
                                    <>
                                        <input
                                            className="env-var-key-input"
                                            value={envVar.key}
                                            readOnly
                                            disabled
                                        />
                                        <input
                                            className="env-var-value-input"
                                            value={envVar.value}
                                            onChange={e => onUpdate(envVar.key, { value: e.target.value })}
                                            onBlur={() => setEditingKey(null)}
                                            autoFocus
                                        />
                                    </>
                                ) : (
                                    <>
                                        <span
                                            className={`env-var-key ${!envVar.enabled ? 'disabled' : ''}`}
                                            onClick={() => setEditingKey(envVar.key)}
                                        >
                                            {envVar.key}
                                        </span>
                                        <span
                                            className={`env-var-value ${!envVar.enabled ? 'disabled' : ''}`}
                                            onClick={() => setEditingKey(envVar.key)}
                                        >
                                            {envVar.value}
                                        </span>
                                    </>
                                )}
                            </div>
                            <button
                                className="env-var-delete"
                                onClick={() => onRemove(envVar.key)}
                                title="Delete"
                            >
                                ×
                            </button>
                        </div>
                    ))
                )}
            </div>

            <div className="env-var-add">
                <input
                    type="text"
                    placeholder="Variable name"
                    value={newKey}
                    onChange={e => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                    onKeyPress={handleKeyPress}
                    className="env-var-new-key"
                />
                <input
                    type="text"
                    placeholder="Value"
                    value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    className="env-var-new-value"
                />
                <button
                    className="env-var-add-btn"
                    onClick={handleAdd}
                    disabled={!newKey.trim() || !newValue.trim()}
                >
                    +
                </button>
            </div>
        </div>
    )
}
