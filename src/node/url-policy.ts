/**
 * URL navigation policy + embeddability probing, ported from the approach in
 * dsh-better-sidebar's browser tab (src/client/browser.ts + browser-probe.ts)
 * so our host-side `open-url` / preview surface shares the same hardening:
 *
 *  - normalize user input into an http(s) URL, refuse dangerous schemes
 *    (javascript:/data:/file:/…) and loopback hosts — even without `//`;
 *  - probe a target's response headers to surface why a site may refuse to be
 *    embedded or is unreachable, instead of a bare blank/failure.
 *
 * Our browser is a real automation browser (not an iframe), so the "embedding"
 * verdict is advisory — it powers a friendly reason instead of a raw 404.
 * @module dsh-course-selector/url-policy
 */

export type BrowserBlockReason = 'scheme' | 'loopback' | 'non-http'

export type NormalizeResult =
  | { kind: 'ok'; url: string }
  | { kind: 'blocked'; reason: BrowserBlockReason }
  | { kind: 'invalid' }

/** Schemes that must never be navigated, honored even without `//`. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript', 'data', 'file', 'about', 'vbscript', 'blob',
  'mailto', 'tel', 'ftp', 'ftps', 'ws', 'wss', 'sftp', 'ssh',
  'chrome', 'chrome-extension', 'moz-extension', 'edge', 'opera', 'resource', 'view-source',
])

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  const parts = host.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Normalize an address-bar / panel input against the navigation policy.
 * Bare hosts get `https://`; an explicit scheme prefix is honored only when
 * it is http(s) (or a known-forbidden scheme); "example.com:8080" is treated
 * as a host, not a `scheme:` (dots are legal in scheme names).
 */
export function normalizeUrl(input: string): NormalizeResult {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'invalid' }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  let withScheme: string
  if (schemeMatch === null) {
    withScheme = `https://${trimmed}`
  } else {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (scheme === 'http' || scheme === 'https') withScheme = trimmed
    else if (FORBIDDEN_SCHEMES.has(scheme)) return { kind: 'blocked', reason: 'scheme' }
    else withScheme = `https://${trimmed}`
  }
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { kind: 'invalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', reason: 'non-http' }
  if (isLoopbackHostname(url.hostname)) return { kind: 'blocked', reason: 'loopback' }
  return { kind: 'ok', url: url.href }
}

/** One host header-probe result. */
export interface HeadProbeResult {
  reachable: boolean
  url?: string
  status?: number
  xFrameOptions?: string
  /** CSP frame-ancestors source list, when the directive exists. */
  frameAncestors?: string[]
}

export type Embeddability = 'embeddable' | 'blocked' | 'unknown'

/** Whether a site forbids being embedded (advisory; not our primary model). */
export function embeddabilityOf(probe: HeadProbeResult): Embeddability {
  if (probe.reachable !== true) return 'unknown'
  const xfo = probe.xFrameOptions?.trim().toUpperCase()
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return 'blocked'
  if (probe.frameAncestors !== undefined && !probe.frameAncestors.some((s) => s === '*')) return 'blocked'
  return 'embeddable'
}

/** Extract the CSP `frame-ancestors` source list, or undefined when absent. */
export function extractFrameAncestors(csp: string | null): string[] | undefined {
  if (csp === null) return undefined
  for (const directive of csp.split(';')) {
    const parts = directive.trim().split(/\s+/)
    if (parts[0] === 'frame-ancestors') {
      const sources = parts.slice(1).filter((s) => s !== '')
      return sources.length === 0 ? undefined : sources
    }
  }
  return undefined
}

/**
 * Probe a target's response headers (Node fetch) for reachability and
 * embed-signals. Body is not buffered (browsed sites can be large).
 */
export async function probeHeaders(url: string, timeoutMs = 8000): Promise<HeadProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-course-selector/1', Accept: '*/*' },
    })
    const csp = resp.headers.get('content-security-policy')
    try { await resp.body?.cancel() } catch { /* body already consumed/closed */ }
    const out: HeadProbeResult = { reachable: true, url: resp.url, status: resp.status }
    const xfo = resp.headers.get('x-frame-options')
    if (xfo) out.xFrameOptions = xfo
    const fa = extractFrameAncestors(csp)
    if (fa) out.frameAncestors = fa
    return out
  } catch {
    return { reachable: false }
  } finally {
    clearTimeout(timer)
  }
}