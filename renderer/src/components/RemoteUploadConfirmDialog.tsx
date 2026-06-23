import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface RemoteUploadConfirmDialogProps {
  fileNames: string[]
  onConfirm: (skipFutureConfirms: boolean) => void
  onCancel: () => void
}

// Shown before a dropped file is uploaded to the remote host's tmp directory.
// The user can permanently silence the prompt; that preference is persisted in
// settings (remoteUploadSkipConfirm) by the caller.
export function RemoteUploadConfirmDialog({ fileNames, onConfirm, onCancel }: Readonly<RemoteUploadConfirmDialogProps>) {
  const { t } = useTranslation()
  const [skipFuture, setSkipFuture] = useState(false)

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>{t('dialogs.remoteUploadTitle')}</h3>
        <p>{t('dialogs.remoteUploadBody', { count: fileNames.length })}</p>
        <ul className="dialog-file-list">
          {fileNames.slice(0, 5).map(name => (
            <li key={name}>{name}</li>
          ))}
          {fileNames.length > 5 && <li>… +{fileNames.length - 5}</li>}
        </ul>
        <label className="dialog-checkbox">
          <input
            type="checkbox"
            checked={skipFuture}
            onChange={e => setSkipFuture(e.target.checked)}
          />
          {t('dialogs.remoteUploadDontAskAgain')}
        </label>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="dialog-btn confirm" onClick={() => onConfirm(skipFuture)}>
            {t('dialogs.remoteUploadConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
