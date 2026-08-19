/**
 * 客户端半区（浏览器）：三个槽位挂载——sidebar.footer.action 开关、
 * conversation.input.dock 状态条、shell.overlay 侧边面板（P0.5：镜像 + 工具栏 +
 * 状态轮询）。纯 React hooks + createElement，react 由 shell 提供。
 * @module dsh-course-selector/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { createPanelStore, type PanelStore } from './store.ts'

/** Client services this plugin consumes (grants `ctx.slots` etc. at the proxy). */
export const inject = ['slots']

type StatusPayload = { url: string; ready: string; engine: string; window: string; frameAgeMs: number }

async function pollStatus(panel: PanelStore): Promise<void> {
  try {
    const res = await fetch('/course-selector/status', { cache: 'no-store' })
    if (!res.ok) return
    const s = (await res.json()) as StatusPayload
    panel.setBrowser(s.url, s.ready === 'complete')
    panel.setStatus(s.url ? '已打开 ' + s.url : '选课助手空闲')
  } catch {
    // Host not reachable yet; next tick retries.
  }
}

/** Ask the host to load the course-system origin (panel open button). */
function requestOpen(): void {
  void fetch('/course-selector/open', { method: 'POST' }).catch(() => { /* next poll reflects state */ })
}

/** Explicitly jump to the selection interface (even when viewing another page). */
function gotoSelection(): void {
  void fetch('/course-selector/open?force=1', { method: 'POST' }).catch(() => {})
}

/** Save the teacher-rating site URL on the host (persisted). */
function saveRatingUrl(url: string): void {
  void fetch('/course-selector/rating-url?url=' + encodeURIComponent(url), { cache: 'no-store' }).catch(() => {})
}

/** Open the teacher-rating site in the course browser. */
function openRatingUrl(url: string): void {
  void fetch('/course-selector/open-url?url=' + encodeURIComponent(url), { cache: 'no-store' }).catch(() => {})
}

function SidebarAction({ panel }: { panel: PanelStore }) {
  const state = useSyncExternalStore(panel.subscribe, panel.getState)
  return h('button',
    { onClick: () => { const wasOpen = state.open; panel.toggle(); if (!wasOpen) requestOpen() }, style: { width: '100%', textAlign: 'left' } },
    '选课助手' + (state.open ? '（展开中）' : ''),
  )
}

function StatusStrip({ panel }: { panel: PanelStore }) {
  const state = useSyncExternalStore(panel.subscribe, panel.getState)
  useEffect(() => {
    void pollStatus(panel)
    const timer = setInterval(() => { void pollStatus(panel) }, 2000)
    return () => clearInterval(timer)
  }, [panel])
  return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 8px' } },
    h('span', { style: { color: state.ready ? '#2e7d32' : '#b26a00' } }, '●'),
    h('span', null, state.status),
  )
}

function OverlayPanel({ panel }: { panel: PanelStore }) {
  const state = useSyncExternalStore(panel.subscribe, panel.getState)
  const tick = useState(0)
  const ratingUrl = useState('https://dahua309.uk')
  const refresh = (): void => tick[1](tick[0] + 1)
  useEffect(() => {
    if (!state.open) return
    void pollStatus(panel)
    const timer = setInterval(() => { void pollStatus(panel) }, 700)
    void fetch('/course-selector/rating-url', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d && typeof d.url === 'string') ratingUrl[1](d.url) })
      .catch(() => {})
    return () => clearInterval(timer)
  }, [panel, state.open])
  if (!state.open) return null
  const frameSrc = '/course-selector/mirror.jpg?t=' + Date.now() + '-' + tick[0]
  return h('aside', { style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(38vw, 520px)', background: 'var(--dsw-alias-bg, #fff)', borderLeft: '1px solid var(--dsw-alias-border, #ddd)', display: 'flex', flexDirection: 'column', zIndex: 1000 } },
    h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border, #ddd)' } },
      h('strong', null, '选课助手'),
      h('span', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-text-dim, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, state.url || '未打开页面'),
      h('span', { title: state.ready ? '页面就绪' : '加载中/未打开', style: { color: state.ready ? '#2e7d32' : '#b26a00' } }, '●'),
      h('button', { onClick: gotoSelection, style: { fontWeight: 'bold' } }, '选课'),
      h('button', { onClick: refresh }, '刷新'),
      h('button', { onClick: () => { panel.toggle() } }, '收起'),
    ),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--dsw-alias-border, #ddd)' } },
      h('span', { style: { fontSize: 12, whiteSpace: 'nowrap' } }, '评分站'),
      h('input', {
        style: { flex: 1, minWidth: 0, padding: '4px 6px', fontSize: 12 },
        value: ratingUrl[0],
        onInput: (e: { target: { value: string } }) => { ratingUrl[1](e.target.value) },
        onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') saveRatingUrl(ratingUrl[0]) },
      }),
      h('button', { onClick: () => saveRatingUrl(ratingUrl[0]) }, '保存'),
      h('button', { onClick: () => openRatingUrl(ratingUrl[0]) }, '打开'),
    ),
    h('div', { style: { flex: 1, overflow: 'auto', background: '#fafafa' } },
      state.url
        ? h('img', { src: frameSrc, style: { width: '100%', display: 'block' }, alt: '浏览器镜像' })
        : h('p', { style: { padding: '16px', color: 'var(--dsw-alias-text-dim, #888)' } },
            '尚未打开页面。'),
      !state.url
        ? h('div', { style: { padding: '0 16px 16px' } },
            h('button', { onClick: requestOpen, style: { width: '100%', padding: '8px', cursor: 'pointer' } }, '打开选课系统'),
          )
        : null,
    ),
    h('footer', { style: { padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border, #ddd)', fontSize: 12 } },
      state.status + ' · course-selector P0.5'),
  )
}

export function apply(ctx: ClientContext): void {
  const panel = createPanelStore()
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(ctx.slots.inject('sidebar.footer.action',
      () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'course-selector', order: 90 }, () => h(SidebarAction, { panel }) as never)))
    disposers.push(ctx.slots.inject('conversation.input.dock',
      () => ctx.slots.register({ name: 'conversation.input.dock', id: 'course-status', order: 60 }, () => h(StatusStrip, { panel }) as never)))
    disposers.push(ctx.slots.inject('shell.overlay',
      () => ctx.slots.register({ name: 'shell.overlay', id: 'course-selector', order: 10 }, () => h(OverlayPanel, { panel }) as never)))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-course-selector: client registration')
}