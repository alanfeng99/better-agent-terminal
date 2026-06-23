import { useTranslation } from 'react-i18next'

type ProfileWindowCloseRequest = {
  windowId: string
  profileId: string
  windowIndex: number
  windowCount: number
}

interface ProfileWindowCloseDialogProps {
  request: ProfileWindowCloseRequest
  profileName: string
  onTemporaryClose: () => void
  onRemoveFromProfile: () => void
  onCancel: () => void
}

export function ProfileWindowCloseDialog({
  request,
  profileName,
  onTemporaryClose,
  onRemoveFromProfile,
  onCancel,
}: ProfileWindowCloseDialogProps) {
  const { t } = useTranslation()

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>{t('dialogs.closeProfileWindow')}</h3>
        <p>
          {t('dialogs.closeProfileWindowConfirm', {
            profile: profileName,
            index: request.windowIndex,
            count: request.windowCount,
          })}
        </p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="dialog-btn secondary" onClick={onTemporaryClose}>
            {t('dialogs.temporarilyCloseWindow')}
          </button>
          <button className="dialog-btn confirm" onClick={onRemoveFromProfile}>
            {t('dialogs.removeWindowFromProfile')}
          </button>
        </div>
      </div>
    </div>
  )
}
