import type { Workspace, EnvVariable } from '../types'
import { EnvVarEditor } from './EnvVarEditor'

interface WorkspaceEnvDialogProps {
    workspace: Workspace
    onAdd: (envVar: EnvVariable) => void
    onRemove: (key: string) => void
    onUpdate: (key: string, updates: Partial<EnvVariable>) => void
    onClose: () => void
}

export function WorkspaceEnvDialog({
    workspace,
    onAdd,
    onRemove,
    onUpdate,
    onClose
}: Readonly<WorkspaceEnvDialogProps>) {
    return (
        <div className="dialog-overlay" onClick={onClose}>
            <div className="workspace-env-dialog" onClick={e => e.stopPropagation()}>
                <div className="dialog-header">
                    <h2>Environment Variables</h2>
                    <span className="dialog-subtitle">{workspace.alias || workspace.name}</span>
                    <button className="dialog-close-btn" onClick={onClose}>×</button>
                </div>
                <div className="dialog-content">
                    <p className="env-dialog-hint">
                        Configure environment variables for this workspace. These will be applied to all terminals in this workspace.
                    </p>
                    <EnvVarEditor
                        envVars={workspace.envVars || []}
                        onAdd={onAdd}
                        onRemove={onRemove}
                        onUpdate={onUpdate}
                    />
                </div>
            </div>
        </div>
    )
}
