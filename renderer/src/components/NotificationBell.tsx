import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notificationStore, type NotificationEntry } from '../stores/notification-store'

function formatRelative(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Math.max(0, Date.now() - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('notifications.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('notifications.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('notifications.hoursAgo', { count: hr })
  const day = Math.floor(hr / 24)
  return t('notifications.daysAgo', { count: day })
}

export function NotificationBell() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<NotificationEntry[]>(notificationStore.getEntries())
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    notificationStore.init()
    const unsub = notificationStore.subscribe(() => {
      setEntries(notificationStore.getEntries().slice())
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  const unread = entries.reduce((n, e) => (e.read ? n : n + 1), 0)

  const onEntryClick = (entry: NotificationEntry) => {
    notificationStore.focusEntry(entry.id)
    setOpen(false)
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        className="settings-btn"
        onClick={() => setOpen(o => !o)}
        title={t('notifications.title')}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, position: 'relative' }}
      >
        <span style={{ fontSize: 14 }}>🔔</span>
        <span>{t('notifications.title')}</span>
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 6,
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: '#e04848',
              color: '#fff',
              fontSize: 11,
              lineHeight: '18px',
              textAlign: 'center',
              fontWeight: 600,
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            maxHeight: 360,
            overflowY: 'auto',
            background: 'var(--bg-elevated, #1e1e1e)',
            border: '1px solid var(--border-color, #333)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 10px',
              borderBottom: '1px solid var(--border-color, #333)',
              fontSize: 12,
              color: 'var(--text-secondary, #aaa)',
            }}
          >
            <span>{t('notifications.title')}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => notificationStore.markAllRead()}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', fontSize: 11 }}
              >
                {t('notifications.markAllRead')}
              </button>
              <button
                onClick={() => notificationStore.clear()}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', fontSize: 11 }}
              >
                {t('notifications.clear')}
              </button>
            </div>
          </div>
          {entries.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary, #888)', fontSize: 12 }}>
              {t('notifications.empty')}
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                onClick={() => onEntryClick(entry)}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border-color, #2a2a2a)',
                  cursor: 'pointer',
                  background: entry.read ? 'transparent' : 'rgba(76, 175, 80, 0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover, #2a2a2a)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = entry.read ? 'transparent' : 'rgba(76, 175, 80, 0.06)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {!entry.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4caf50', flexShrink: 0 }} />}
                  <span style={{ fontSize: 13, color: 'var(--text-primary, #ddd)', fontWeight: entry.read ? 'normal' : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.workspaceName} {t('notifications.ends')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>
                  {formatRelative(entry.timestamp, t)}
                  {entry.agentKind ? ` · ${entry.agentKind}` : ''}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
