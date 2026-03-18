import { useTranslation } from 'react-i18next'
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
    const { t } = useTranslation()
    return (
        <div className="dialog-overlay" onClick={onClose}>
            <div className="workspace-env-dialog" onClick={e => e.stopPropagation()}>
                <div className="dialog-header">
                    <h2>{t('envVars.title')}</h2>
                    <span className="dialog-subtitle">{workspace.alias || workspace.name}</span>
                    <button className="dialog-close-btn" onClick={onClose}>×</button>
                </div>
                <div className="dialog-content">
                    <p className="env-dialog-hint">
                        {t('envVars.workspaceHint')}
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
