/**
 * Navigation permission gate (P0.5): a `tools/pre-execute` waterfall listener.
 * - Denies private / loopback / local-host targets outright (SSRF).
 * - Already-allowed hosts pass silently.
 * - New public hosts ask the user through the approval seam when an agent and
 *   an approval service are present; an `allowed-once` answer remembers the
 *   host (persisted to the plugin data dir) and then delegates.
 * - Without an approval channel the gate returns `ask` and lets the harness
 *   route the decision (that path does not persist).
 * @module dsh-course-selector/permission
 */
import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'

export interface HostGate {
  readonly allowed: ReadonlySet<string>
  /** Record a host as allowed; persisted for future sessions. */
  remember: (host: string) => void
}

const ALLOW_FILE = 'allow-hosts.json'

export function createHostGate(persistDir: string, seedHosts?: readonly string[]): HostGate {
  const file = path.join(persistDir, ALLOW_FILE)
  const allowed = new Set<string>()
  for (const seed of seedHosts ?? []) {
    if (seed.length > 0) allowed.add(seed.toLowerCase())
  }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw) as { hosts?: unknown }
    if (Array.isArray(data.hosts)) {
      for (const host of data.hosts) {
        if (typeof host === 'string' && host.length > 0) allowed.add(host.toLowerCase())
      }
    }
  } catch {
    // First run or unreadable file: start empty.
  }
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      try {
        fs.mkdirSync(persistDir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ hosts: [...allowed] }, null, 2), 'utf8')
      } catch { /* best effort */ }
    }, 250)
  }
  return {
    allowed,
    remember: (host) => { allowed.add(host.toLowerCase()); persist() },
  }
}

export function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null // credentials forbidden in nav
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

const IP_LITERAL = /^(0\.|127\.|10\.|192\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d)\.|224\.|240\.|2001:db8:|fe80:|fc00:|fd00:|::1$|::$)/

/** Tools that always require user approval before dispatch (kept empty:
 *  course_submit was removed by policy — this project only recommends courses). */
const RISKY_TOOLS = new Set<string>()

/** Whether a hostname may be navigated to without approval (P0 heuristic; full url-guard in P1). */
export function isPublicHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return false
  if (IP_LITERAL.test(host)) return false
  return true
}

type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

interface PreExecContext {
  readonly name: string
  readonly callId: unknown
  readonly arguments: unknown
  readonly agent?: { id: unknown }
  readonly signal?: AbortSignal
}

interface ApprovalLike {
  request(req: {
    agent: { id: unknown }
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | string>
}

export function registerPermissionGate(ctx: Context, gate: HostGate): () => void {
  const listener = async (
    exec: unknown,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> => {
    const e = exec as PreExecContext
    // Tool-level approval: high-risk actions ask regardless of URL.
    if (RISKY_TOOLS.has(e.name)) {
      if (!e.agent) return { kind: 'ask', reason: '高危操作：' + e.name }
      const approval = ctx.get('approval') as ApprovalLike | undefined
      if (!approval) return { kind: 'ask', reason: '高危操作：' + e.name }
      const outcome = await approval.request({
        agent: e.agent,
        toolName: e.name,
        ...(typeof e.callId === 'string' ? { callId: e.callId } : {}),
        reason: '高危操作：' + e.name + '，是否继续？',
        ...(e.signal ? { signal: e.signal } : {}),
      })
      return outcome === 'allowed-once' ? next() : { kind: 'deny', reason: '已拒绝：' + e.name }
    }
    const args = typeof e.arguments === 'object' && e.arguments !== null ? e.arguments as Record<string, unknown> : {}
    const rawUrl = typeof args['url'] === 'string' ? args['url'] : ''
    if (rawUrl === '') return next()
    const host = hostnameOf(rawUrl)
    if (host === null) return next() // non-http or unparseable
    if (!isPublicHostname(host)) {
      return { kind: 'deny', reason: '导航被拒绝（SSRF 防护）：' + host }
    }
    if (gate.allowed.has(host)) return next()
    if (!e.agent) return { kind: 'ask', reason: '允许访问 ' + host + '？' }
    const approval = ctx.get('approval') as ApprovalLike | undefined
    if (!approval) return { kind: 'ask', reason: '允许访问 ' + host + '？' }
    const outcome = await approval.request({
      agent: e.agent,
      toolName: e.name,
      ...(typeof e.callId === 'string' ? { callId: e.callId } : {}),
      reason: '允许访问 ' + host + '？',
      ...(e.signal ? { signal: e.signal } : {}),
    })
    if (outcome === 'allowed-once') {
      gate.remember(host) // persist before releasing
      return next()
    }
    return { kind: 'deny', reason: '已拒绝访问 ' + host }
  }
  return ctx.on('tools/pre-execute', listener as never) as unknown as () => void
}