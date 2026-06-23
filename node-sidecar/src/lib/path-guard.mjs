// Deny-list guard for filesystem reads. Mirror of electron/path-guard.ts
// + src-tauri/src/path_guard.rs so the same well-known credential stores
// stay blocked across all three hosts.
//
// This is harm-reduction, not a sandbox: legitimate uses (~/.bashrc,
// /etc/hosts, project trees) still resolve. Stricter scoping lives at
// the IPC layer via ctx.isRemote, which the sidecar doesn't currently
// thread through to here.

import * as os from 'os'
import * as path from 'path'

const home = os.homedir()

const DENIED_SUFFIXES = [
  // SSH keys
  path.join(home, '.ssh'),
  // AWS credentials
  path.join(home, '.aws', 'credentials'),
  path.join(home, '.aws', 'config'),
  // GCP service account keys
  path.join(home, '.config', 'gcloud'),
  // GitHub / gh CLI
  path.join(home, '.config', 'gh', 'hosts.yml'),
  // Generic secrets
  path.join(home, '.netrc'),
  path.join(home, '.pgpass'),
  // Kubernetes contexts
  path.join(home, '.kube', 'config'),
  // macOS Keychain
  path.join(home, 'Library', 'Keychains'),
  // Browser credential stores (Login Data, Cookies)
  path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  path.join(home, 'Library', 'Application Support', 'BraveSoftware'),
  path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
  path.join(home, 'Library', 'Application Support', 'Firefox'),
  // BAT's own secrets (token + cert + claude account creds)
  path.join(home, 'Library', 'Application Support', 'better-agent-terminal', 'server-cert.enc.json'),
  path.join(home, 'Library', 'Application Support', 'better-agent-terminal', 'server-token.enc.json'),
  path.join(home, 'Library', 'Application Support', 'better-agent-terminal', 'claude-account-creds.enc.json'),
  // Linux / XDG
  path.join(home, '.config', 'better-agent-terminal', 'server-cert.enc.json'),
  path.join(home, '.config', 'better-agent-terminal', 'server-token.enc.json'),
  path.join(home, '.mozilla'),
  // Claude Code CLI state
  path.join(home, '.claude', '.credentials.json'),
  // Windows credential store (best-effort; WinAPI stores also apply)
  'C:\\Windows\\System32\\config',
  // System-wide
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/ssh/ssh_host_rsa_key',
  '/etc/ssh/ssh_host_ed25519_key',
  '/root',
  '/private/etc/master.passwd',
]

// Return true if `absolutePath` lies inside any denied directory or IS
// a denied file. Caller is expected to pre-resolve via path.resolve.
export function isSensitivePath(absolutePath) {
  if (!absolutePath || typeof absolutePath !== 'string') return true
  const normalized = path.normalize(absolutePath)
  for (const denied of DENIED_SUFFIXES) {
    const normDenied = path.normalize(denied)
    if (normalized === normDenied) return true
    if (normalized.startsWith(normDenied + path.sep)) return true
  }
  // Block well-known private key naming patterns (id_rsa, *.pem under
  // .ssh/ or keys/) regardless of where they live in the tree.
  const base = path.basename(normalized)
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)
      && normalized.includes(`${path.sep}.ssh${path.sep}`)) return true
  if (/\.pem$/i.test(base)
      && (normalized.includes(`${path.sep}.ssh${path.sep}`)
          || normalized.includes(`${path.sep}keys${path.sep}`))) return true
  return false
}
