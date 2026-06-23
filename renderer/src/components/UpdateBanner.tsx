import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { subscribeUpdate, getUpdateState, dismissUpdate } from '../lib/auto-update'

const barStyle: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 12,
  transform: 'translateX(-50%)',
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  maxWidth: 'min(560px, 92vw)',
  padding: '8px 14px',
  borderRadius: 8,
  fontSize: 13,
  lineHeight: 1.4,
  background: 'var(--bg-secondary, #26231f)',
  color: 'var(--text-primary, #dfdbc3)',
  border: '1px solid var(--border-color, #3a352e)',
  boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
}

const dismissStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary, #9a948a)',
  cursor: 'pointer',
  fontSize: 13,
  padding: '2px 6px',
}

/**
 * Bottom-centered banner driven by the background auto-update controller.
 * "ready" persists until the user restarts (that's when the staged update
 * applies); "downloading" shows progress; "error" is dismissable.
 */
export function UpdateBanner() {
  const { t } = useTranslation()
  const state = useSyncExternalStore(subscribeUpdate, getUpdateState)

  if (state.status === 'ready') {
    return (
      <div style={barStyle} role="status">
        <span>✅ {t('update.readyBody', { version: state.version })}</span>
      </div>
    )
  }

  if (state.status === 'downloading') {
    const pct = state.total ? Math.round((state.downloaded / state.total) * 100) : null
    return (
      <div style={barStyle} role="status">
        <span>⬇️ {pct != null ? t('update.downloadingPct', { pct }) : t('update.downloading')}</span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div style={barStyle} role="alert">
        <span>⚠️ {t('update.error')}</span>
        <button style={dismissStyle} onClick={dismissUpdate}>{t('update.dismiss')}</button>
      </div>
    )
  }

  return null
}
