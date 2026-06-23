import { useCallback, useState } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'

// Shared controller for "file dropped into a remote-connected agent panel".
// Flow: requestUpload(paths) → confirm dialog (unless the user permanently
// opted out via settings.remoteUploadSkipConfirm) → each file is streamed to
// the host's tmp dir over the remote transport → onUploaded(hostPath) lets the
// panel attach the host-side reference to the conversation.
export interface RemoteDropUploadController {
  /** Basenames awaiting user confirmation, or null when no dialog is open. */
  pendingFileNames: string[] | null
  requestUpload: (paths: string[]) => void
  confirmUpload: (skipFutureConfirms: boolean) => void
  cancelUpload: () => void
  uploading: boolean
}

export function useRemoteDropUpload(
  onUploaded: (hostPath: string) => void | Promise<void>,
): RemoteDropUploadController {
  const [pendingPaths, setPendingPaths] = useState<string[] | null>(null)
  const [uploading, setUploading] = useState(false)

  const performUpload = useCallback(async (paths: string[]) => {
    setUploading(true)
    try {
      for (const localPath of paths) {
        try {
          const hostPath = await host.remoteFs.uploadToHostTmp(localPath)
          await onUploaded(hostPath)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          window.alert(`Upload to remote host failed: ${message}`)
        }
      }
    } finally {
      setUploading(false)
    }
  }, [onUploaded])

  const requestUpload = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    if (settingsStore.getRemoteUploadSkipConfirm()) {
      void performUpload(paths)
    } else {
      setPendingPaths(paths)
    }
  }, [performUpload])

  const confirmUpload = useCallback((skipFutureConfirms: boolean) => {
    if (skipFutureConfirms) settingsStore.setRemoteUploadSkipConfirm(true)
    const paths = pendingPaths
    setPendingPaths(null)
    if (paths) void performUpload(paths)
  }, [pendingPaths, performUpload])

  const cancelUpload = useCallback(() => setPendingPaths(null), [])

  const pendingFileNames = pendingPaths
    ? pendingPaths.map(p => p.split(/[\\/]/).pop() || p)
    : null

  return { pendingFileNames, requestUpload, confirmUpload, cancelUpload, uploading }
}
