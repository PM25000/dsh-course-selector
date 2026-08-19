/**
 * 面板状态（P0.5）：开关 + 状态文本 + 当前页面 url/就绪。镜像帧与状态由
 * 组件按需轮询 /course-selector/{mirror.jpg,status}，不落地到 store。
 * @module dsh-course-selector/client/store
 */
export interface PanelState {
  open: boolean
  status: string
  url: string
  ready: boolean
}

export interface PanelStore {
  getState(): PanelState
  subscribe(listener: () => void): () => void
  setOpen(open: boolean): void
  toggle(): void
  setStatus(status: string): void
  setBrowser(url: string, ready: boolean): void
}

export function createPanelStore(): PanelStore {
  let state: PanelState = { open: false, status: '选课助手空闲', url: '', ready: false }
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of [...listeners]) listener() }
  return {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setOpen: (open) => { state = { ...state, open }; emit() },
    toggle: () => { state = { ...state, open: !state.open }; emit() },
    setStatus: (status) => { state = { ...state, status }; emit() },
    setBrowser: (url, ready) => { state = { ...state, url, ready }; emit() },
  }
}