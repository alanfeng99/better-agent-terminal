import { host } from '../host-api'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import '../styles/github-panel.css'

interface GitHubPanelProps {
  workspaceFolderPath: string
  onSendToClaude?: (content: string) => Promise<boolean>
}

interface GitHubPR {
  number: number
  title: string
  state: string
  author: { login: string }
  createdAt: string
  updatedAt: string
  labels: { name: string }[]
  headRefName: string
  isDraft: boolean
}

interface GitHubIssue {
  number: number
  title: string
  state: string
  author: { login: string }
  createdAt: string
  updatedAt: string
  labels: { name: string }[]
}

interface PRDetail {
  number: number
  title: string
  state: string
  author: { login: string }
  body: string
  comments: { author: { login: string }; body: string; createdAt: string }[]
  reviews: { author: { login: string }; body: string; state: string }[]
  createdAt: string
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  files: { path: string; additions: number; deletions: number }[]
}

interface IssueDetail {
  number: number
  title: string
  state: string
  author: { login: string }
  body: string
  comments: { author: { login: string }; body: string; createdAt: string }[]
  createdAt: string
  labels: { name: string }[]
}

type SubTab = 'prs' | 'issues'

function formatTimeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return i18next.t('git.justNow')
  if (diffMins < 60) return i18next.t('git.minutesAgo', { count: diffMins })
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return i18next.t('git.hoursAgo', { count: diffHours })
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return i18next.t('git.daysAgo', { count: diffDays })
  return d.toLocaleDateString()
}

function stateColor(state: string): string {
  switch (state.toUpperCase()) {
    case 'OPEN': return '#4ec9b0'
    case 'CLOSED': return '#f44336'
    case 'MERGED': return '#a371f7'
    default: return '#888'
  }
}

export function GitHubPanel({ workspaceFolderPath, onSendToClaude }: Readonly<GitHubPanelProps>) {
  const { t } = useTranslation()
  const [consentGiven, setConsentGiven] = useState(() => {
    try { return localStorage.getItem('bat-github-consent') === 'true' } catch { return false }
  })
  const [cliStatus, setCliStatus] = useState<{ installed: boolean; authenticated: boolean } | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('prs')
  const [prs, setPrs] = useState<GitHubPR[]>([])
  const [issues, setIssues] = useState<GitHubIssue[]>([])
  const [selectedItem, setSelectedItem] = useState<{ type: 'pr' | 'issue'; number: number } | null>(null)
  const [detail, setDetail] = useState<PRDetail | IssueDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentMessage, setSentMessage] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: GitHubPR | GitHubIssue } | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [commentPosting, setCommentPosting] = useState(false)
  const [commentStatus, setCommentStatus] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [prResult, issueResult] = await Promise.all([
        host.github.listPRs(workspaceFolderPath),
        host.github.listIssues(workspaceFolderPath),
      ])
      if (prResult && 'error' in prResult) {
        setError(prResult.error as string)
      } else {
        setPrs(prResult as GitHubPR[])
      }
      if (issueResult && 'error' in issueResult) {
        if (!error) setError(issueResult.error as string)
      } else {
        setIssues(issueResult as GitHubIssue[])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [workspaceFolderPath])

  // Check CLI and load data on consent
  useEffect(() => {
    if (!consentGiven) return
    host.github.checkCli().then(status => {
      setCliStatus(status)
      if (status.installed && status.authenticated) {
        loadData()
      }
    }).catch(() => setCliStatus({ installed: false, authenticated: false }))
  }, [consentGiven, loadData])

  // Load detail when item selected
  useEffect(() => {
    if (!selectedItem) { setDetail(null); return }
    setCommentBody('')
    setDetailLoading(true)
    const promise = selectedItem.type === 'pr'
      ? host.github.viewPR(workspaceFolderPath, selectedItem.number)
      : host.github.viewIssue(workspaceFolderPath, selectedItem.number)
    promise.then(result => {
      if (result && 'error' in result) {
        setDetail(null)
        setError(result.error as string)
      } else {
        setDetail(result as PRDetail | IssueDetail)
      }
    }).catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }, [selectedItem, workspaceFolderPath])

  const handleConsent = () => {
    try { localStorage.setItem('bat-github-consent', 'true') } catch { /* ignore */ }
    setConsentGiven(true)
  }

  const handleSendToClaude = async () => {
    if (!detail || !onSendToClaude) return
    let prompt: string
    if (selectedItem?.type === 'pr') {
      const pr = detail as PRDetail
      const files = pr.files?.map(f => `  ${f.path} (+${f.additions} -${f.deletions})`).join('\n') || ''
      const comments = pr.comments?.map(c => `- @${c.author.login}: ${c.body}`).join('\n') || ''
      const reviews = pr.reviews?.filter(r => r.body).map(r => `- @${r.author.login} [${r.state}]: ${r.body}`).join('\n') || ''
      prompt = [
        `[GitHub PR #${pr.number}] ${pr.title}`,
        `Branch: ${pr.headRefName} → ${pr.baseRefName} | Author: @${pr.author.login} | State: ${pr.state} | +${pr.additions} -${pr.deletions}`,
        '',
        pr.body || '(no description)',
        files ? `\nChanged files:\n${files}` : '',
        comments ? `\nComments:\n${comments}` : '',
        reviews ? `\nReviews:\n${reviews}` : '',
        '',
        'Please review this PR and provide feedback.',
      ].filter(Boolean).join('\n')
    } else {
      const issue = detail as IssueDetail
      const labels = issue.labels?.map(l => l.name).join(', ') || ''
      const comments = issue.comments?.map(c => `- @${c.author.login}: ${c.body}`).join('\n') || ''
      prompt = [
        `[GitHub Issue #${issue.number}] ${issue.title}`,
        `Author: @${issue.author.login} | State: ${issue.state}${labels ? ` | Labels: ${labels}` : ''}`,
        '',
        issue.body || '(no description)',
        comments ? `\nComments:\n${comments}` : '',
        '',
        'Please review this issue and provide your analysis.',
      ].filter(Boolean).join('\n')
    }
    const ok = await onSendToClaude(prompt)
    if (ok) {
      setSentMessage(t('github.sentToClaude'))
      setTimeout(() => setSentMessage(null), 2000)
    }
  }

  const getItemUrl = async (item: GitHubPR | GitHubIssue) => {
    const repoUrl = await host.git.getGithubUrl(workspaceFolderPath)
    if (!repoUrl) return null
    const type = 'isDraft' in item ? 'pull' : 'issues'
    return `${repoUrl}/${type}/${item.number}`
  }

  const handlePostComment = async () => {
    if (!selectedItem || !commentBody.trim()) return
    setCommentPosting(true)
    try {
      const fn = selectedItem.type === 'pr'
        ? host.github.commentPR
        : host.github.commentIssue
      const result = await fn(workspaceFolderPath, selectedItem.number, commentBody.trim())
      if (result && 'error' in result) {
        setCommentStatus(t('github.commentError'))
      } else {
        setCommentBody('')
        setCommentStatus(t('github.commentPosted'))
        // Reload detail to show the new comment
        setSelectedItem(prev => prev ? { ...prev } : null)
      }
    } finally {
      setCommentPosting(false)
      setTimeout(() => setCommentStatus(null), 2000)
    }
  }

  // Consent screen
  if (!consentGiven) {
    return (
      <div className="github-panel github-consent">
        <div className="github-consent-card">
          <h3>{t('github.consentTitle')}</h3>
          <p>{t('github.consentMessage')}</p>
          <button className="github-consent-btn" onClick={handleConsent}>
            {t('github.consentButton')}
          </button>
        </div>
      </div>
    )
  }

  // CLI status check
  if (cliStatus && !cliStatus.installed) {
    return (
      <div className="github-panel github-error-screen">
        <div className="github-error-message">{t('github.cliNotInstalled')}</div>
      </div>
    )
  }
  if (cliStatus && !cliStatus.authenticated) {
    return (
      <div className="github-panel github-error-screen">
        <div className="github-error-message">{t('github.notAuthenticated')}</div>
      </div>
    )
  }

  const items = subTab === 'prs' ? prs : issues
  const emptyMessage = subTab === 'prs' ? t('github.noPRs') : t('github.noIssues')

  return (
    <div className="github-panel">
      {contextMenu && (
        <>
          <div className="context-menu-backdrop" onClick={() => setContextMenu(null)} />
          <div
            className="workspace-context-menu"
            style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 1000 }}
          >
            <div className="context-menu-item" onClick={() => {
              getItemUrl(contextMenu.item).then(url => { if (url) host.shell.openExternal(url) })
              setContextMenu(null)
            }}>{t('github.openInGitHub')}</div>
            <div className="context-menu-item" onClick={() => {
              getItemUrl(contextMenu.item).then(url => { if (url) navigator.clipboard.writeText(url) })
              setContextMenu(null)
            }}>{t('github.copyGitHubLink')}</div>
          </div>
        </>
      )}
      {/* Left column: list */}
      <div className="github-list-col">
        <div className="github-sub-tabs">
          <button
            className={`github-sub-tab-btn ${subTab === 'prs' ? 'active' : ''}`}
            onClick={() => { setSubTab('prs'); setSelectedItem(null) }}
          >
            {t('github.pullRequests')} {prs.length > 0 && <span className="github-count">{prs.length}</span>}
          </button>
          <button
            className={`github-sub-tab-btn ${subTab === 'issues' ? 'active' : ''}`}
            onClick={() => { setSubTab('issues'); setSelectedItem(null) }}
          >
            {t('github.issues')} {issues.length > 0 && <span className="github-count">{issues.length}</span>}
          </button>
          <button className="github-refresh-btn" onClick={loadData} title={t('github.refresh')}>⟳</button>
        </div>

        <div className="github-item-list">
          {loading ? (
            <div className="github-empty">{t('github.loading')}</div>
          ) : error ? (
            <div className="github-empty github-error-text">{t('github.fetchError')}</div>
          ) : items.length === 0 ? (
            <div className="github-empty">{emptyMessage}</div>
          ) : (
            items.map(item => (
              <div
                key={item.number}
                className={`github-item ${selectedItem?.number === item.number ? 'active' : ''}`}
                onClick={() => setSelectedItem({ type: subTab === 'prs' ? 'pr' : 'issue', number: item.number })}
                onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, item }) }}
              >
                <div className="github-item-header">
                  <span className="github-item-number">#{item.number}</span>
                  <span className="github-state-badge" style={{ color: stateColor(item.state) }}>
                    {item.state}
                    {'isDraft' in item && (item as GitHubPR).isDraft && ` (${t('github.draft')})`}
                  </span>
                </div>
                <div className="github-item-title">{item.title}</div>
                <div className="github-item-meta">
                  <span>@{item.author.login}</span>
                  <span>{formatTimeAgo(item.createdAt)}</span>
                </div>
                {item.labels.length > 0 && (
                  <div className="github-item-labels">
                    {item.labels.map(l => <span key={l.name} className="github-label">{l.name}</span>)}
                  </div>
                )}
                {subTab === 'prs' && (
                  <div className="github-item-branch">{(item as GitHubPR).headRefName}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right column: detail */}
      <div className="github-detail-col">
        {detailLoading ? (
          <div className="github-detail-placeholder">{t('github.loading')}</div>
        ) : !detail ? (
          <div className="github-detail-placeholder">{t('github.selectItem')}</div>
        ) : (
          <div className="github-detail">
            <div className="github-detail-header">
              <div className="github-detail-title-row">
                <h3>#{detail.number} {detail.title}</h3>
                {onSendToClaude && (
                  <button className="github-send-btn" onClick={handleSendToClaude} title={t('github.sendToClaude')}>
                    {sentMessage || t('github.sendToClaude')}
                  </button>
                )}
              </div>
              <div className="github-detail-meta">
                <span className="github-state-badge" style={{ color: stateColor(detail.state) }}>{detail.state}</span>
                <span>@{detail.author.login}</span>
                <span>{formatTimeAgo(detail.createdAt)}</span>
                {'headRefName' in detail && (
                  <span className="github-detail-branch">
                    {(detail as PRDetail).headRefName} → {(detail as PRDetail).baseRefName}
                  </span>
                )}
                {'additions' in detail && (
                  <span className="github-detail-diff">
                    <span className="github-additions">+{(detail as PRDetail).additions}</span>
                    {' '}
                    <span className="github-deletions">-{(detail as PRDetail).deletions}</span>
                  </span>
                )}
              </div>
            </div>

            <div className="github-detail-body">
              <pre>{detail.body || `(${t('github.noDescription')})`}</pre>
            </div>

            {'files' in detail && (detail as PRDetail).files?.length > 0 && (
              <div className="github-detail-section">
                <h4>{t('github.changedFiles')} ({(detail as PRDetail).files.length})</h4>
                <div className="github-files-list">
                  {(detail as PRDetail).files.map(f => (
                    <div key={f.path} className="github-file-item">
                      <span className="github-file-path">{f.path}</span>
                      <span className="github-file-diff">
                        <span className="github-additions">+{f.additions}</span>
                        {' '}
                        <span className="github-deletions">-{f.deletions}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.comments?.length > 0 && (
              <div className="github-detail-section">
                <h4>{t('github.comments')} ({detail.comments.length})</h4>
                {detail.comments.map((c, i) => (
                  <div key={i} className="github-comment">
                    <div className="github-comment-header">
                      <span className="github-comment-author">@{c.author.login}</span>
                      <span className="github-comment-time">{formatTimeAgo(c.createdAt)}</span>
                    </div>
                    <pre className="github-comment-body">{c.body}</pre>
                  </div>
                ))}
              </div>
            )}

            {'reviews' in detail && (detail as PRDetail).reviews?.filter(r => r.body).length > 0 && (
              <div className="github-detail-section">
                <h4>{t('github.reviews')} ({(detail as PRDetail).reviews.filter(r => r.body).length})</h4>
                {(detail as PRDetail).reviews.filter(r => r.body).map((r, i) => (
                  <div key={i} className="github-comment">
                    <div className="github-comment-header">
                      <span className="github-comment-author">@{r.author.login}</span>
                      <span className="github-review-state">{r.state}</span>
                    </div>
                    <pre className="github-comment-body">{r.body}</pre>
                  </div>
                ))}
              </div>
            )}
            <div className="github-detail-section github-comment-input-section">
              <textarea
                className="github-comment-textarea"
                placeholder={t('github.addComment')}
                value={commentBody}
                onChange={e => setCommentBody(e.target.value)}
                rows={3}
                disabled={commentPosting}
              />
              <div className="github-comment-actions">
                {commentStatus && <span className="github-comment-status">{commentStatus}</span>}
                <button
                  className="github-send-btn"
                  onClick={handlePostComment}
                  disabled={commentPosting || !commentBody.trim()}
                >
                  {commentPosting ? t('github.loading') : t('github.submitComment')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
