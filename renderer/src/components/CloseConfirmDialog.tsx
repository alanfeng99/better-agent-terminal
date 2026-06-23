import { useTranslation } from 'react-i18next'

interface CloseConfirmDialogProps {
  onConfirm: () => void
  onCancel: () => void
  isWorktree?: boolean
  worktreeMerged?: boolean
  onConfirmAndClean?: () => void
}

export function CloseConfirmDialog({ onConfirm, onCancel, isWorktree, worktreeMerged, onConfirmAndClean }: CloseConfirmDialogProps) {
  const { t } = useTranslation()

  const body = !isWorktree
    ? t('dialogs.closeCodeAgentConfirm')
    : worktreeMerged
      ? t('dialogs.closeWorktreeSessionMergedConfirm')
      : t('dialogs.closeWorktreeSessionConfirm')

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>{isWorktree ? t('dialogs.closeWorktreeSession') : t('dialogs.closeCodeAgent')}</h3>
        <p>{body}</p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          {isWorktree && onConfirmAndClean && (
            <button
              className={`dialog-btn confirm${worktreeMerged ? '' : ' danger'}`}
              onClick={onConfirmAndClean}
            >
              {t('dialogs.closeAndCleanWorktree')}
            </button>
          )}
          <button className="dialog-btn confirm" onClick={onConfirm}>
            {isWorktree ? t('dialogs.closeKeepWorktree') : t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
