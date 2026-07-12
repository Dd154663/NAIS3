/**
 * Google Drive 플로팅 패널 (P6-5) — 웹 전용, plain DOM.
 *
 * 원작 React 앱을 건드리지 않고 bootstrap이 document.body에 직접 마운트한다.
 * 앱 테마 CSS 변수(--paper/--ink/--accent 등)를 그대로 써서 라이트/다크 자동 대응.
 * 토큰 발급은 버튼 클릭(사용자 제스처)에서만 — GIS 팝업 차단 회피.
 */
import { subscribe } from './bus'
import {
  connectDrive,
  disconnectDrive,
  drainDrive,
  gdriveStatus,
  setDriveCacheLimit,
  type GDriveStatus
} from './gdrive-controller'

const CSS = `
#nais3-gd-fab {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); font-family: var(--font-ui);
  font-size: 13px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.18);
}
#nais3-gd-fab:hover { background: var(--surface-2); }
#nais3-gd-fab .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
#nais3-gd-fab.on .dot { background: var(--accent); }
#nais3-gd-fab.warn .dot { background: var(--danger); }
#nais3-gd-panel {
  position: fixed; right: 16px; bottom: 60px; z-index: 2147483000;
  width: 288px; max-width: calc(100vw - 32px);
  background: var(--paper); color: var(--ink); font-family: var(--font-ui);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: 0 8px 30px rgba(0,0,0,.28); padding: 14px; display: none;
}
#nais3-gd-panel.open { display: block; }
#nais3-gd-panel h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.nais3-gd-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; font-size: 13px; }
.nais3-gd-badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--surface-2); color: var(--muted); }
.nais3-gd-badge.on { background: var(--accent-soft); color: var(--accent); }
.nais3-gd-badge.warn { background: var(--accent-soft); color: var(--danger); }
.nais3-gd-btn {
  padding: 7px 12px; border-radius: var(--radius); border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); font-family: var(--font-ui);
  font-size: 13px; cursor: pointer; width: 100%;
}
.nais3-gd-btn:hover { background: var(--surface-2); }
.nais3-gd-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.nais3-gd-btn.primary:hover { filter: brightness(1.05); }
.nais3-gd-btn.small { width: auto; padding: 4px 10px; font-size: 12px; }
.nais3-gd-num { width: 64px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); font-family: var(--font-mono); font-size: 12px; text-align: right; }
.nais3-gd-note { font-size: 11px; color: var(--muted); line-height: 1.5; margin-top: 8px; }
.nais3-gd-x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 0 2px; }
`

export function mountGdrivePanel(): void {
  if (document.getElementById('nais3-gd-fab')) return

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const fab = document.createElement('button')
  fab.id = 'nais3-gd-fab'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const fabLabel = document.createElement('span')
  fabLabel.textContent = 'Drive'
  fab.append(dot, fabLabel)

  const panel = document.createElement('div')
  panel.id = 'nais3-gd-panel'

  // 헤더
  const header = document.createElement('div')
  header.className = 'nais3-gd-row'
  const title = document.createElement('h3')
  title.textContent = 'Google Drive 저장'
  title.style.margin = '0'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'nais3-gd-x'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', '닫기')
  header.append(title, closeBtn)

  // 상태
  const statusRow = document.createElement('div')
  statusRow.className = 'nais3-gd-row'
  const statusLabel = document.createElement('span')
  statusLabel.textContent = '상태'
  const badge = document.createElement('span')
  badge.className = 'nais3-gd-badge'
  statusRow.append(statusLabel, badge)

  // 주 동작 버튼
  const actionBtn = document.createElement('button')
  actionBtn.className = 'nais3-gd-btn primary'

  // 대기열
  const queueRow = document.createElement('div')
  queueRow.className = 'nais3-gd-row'
  const queueLabel = document.createElement('span')
  const retryBtn = document.createElement('button')
  retryBtn.className = 'nais3-gd-btn small'
  retryBtn.textContent = '재시도'
  queueRow.append(queueLabel, retryBtn)

  // 캐시 한도
  const cacheRow = document.createElement('div')
  cacheRow.className = 'nais3-gd-row'
  const cacheLabel = document.createElement('span')
  cacheLabel.textContent = '로컬 보관 매수'
  const cacheInput = document.createElement('input')
  cacheInput.type = 'number'
  cacheInput.min = '1'
  cacheInput.className = 'nais3-gd-num'
  cacheRow.append(cacheLabel, cacheInput)

  const note = document.createElement('div')
  note.className = 'nais3-gd-note'
  note.textContent =
    '원본은 Google Drive(NAIS3 폴더)에 저장되고, 최근 N장만 기기에 보관됩니다. ' +
    '나머지는 필요할 때 Drive에서 불러옵니다. 썸네일은 항상 기기에 남습니다.'

  panel.append(header, statusRow, actionBtn, queueRow, cacheRow, note)
  document.body.append(fab, panel)

  // ── 상태 반영 ──────────────────────────────────────────────
  let busy = false
  function render(s: GDriveStatus): void {
    const connected = s.enabled && s.hasToken
    const reconnect = s.enabled && !s.hasToken
    fab.classList.toggle('on', connected)
    fab.classList.toggle('warn', reconnect)

    badge.className = 'nais3-gd-badge' + (connected ? ' on' : reconnect ? ' warn' : '')
    badge.textContent = connected ? '연결됨' : reconnect ? '재연결 필요' : '연결 안 됨'

    actionBtn.textContent = connected
      ? '연결 해제'
      : reconnect
        ? '재연결'
        : 'Google Drive 연결'
    actionBtn.className = 'nais3-gd-btn' + (connected ? '' : ' primary')

    queueRow.style.display = s.queueLength > 0 ? 'flex' : 'none'
    queueLabel.textContent = `업로드 대기: ${s.queueLength}건`
    if (document.activeElement !== cacheInput) cacheInput.value = String(s.cacheLimit)
  }

  async function refresh(): Promise<void> {
    try {
      render(await gdriveStatus())
    } catch {
      /* 워커 미준비 등 — 다음 주기에 재시도 */
    }
  }

  async function withBusy(label: string, fn: () => Promise<unknown>): Promise<void> {
    if (busy) return
    busy = true
    const prev = actionBtn.textContent
    actionBtn.textContent = label
    actionBtn.disabled = true
    try {
      await fn()
    } catch (e) {
      badge.className = 'nais3-gd-badge warn'
      badge.textContent = e instanceof Error ? e.message.slice(0, 40) : '실패'
    } finally {
      actionBtn.disabled = false
      busy = false
      if (actionBtn.textContent === label) actionBtn.textContent = prev
      await refresh()
    }
  }

  // ── 이벤트 ────────────────────────────────────────────────
  fab.addEventListener('click', () => {
    panel.classList.toggle('open')
    if (panel.classList.contains('open')) void refresh()
  })
  closeBtn.addEventListener('click', () => panel.classList.remove('open'))

  actionBtn.addEventListener('click', () => {
    void gdriveStatus().then((s) => {
      if (s.enabled && s.hasToken) return withBusy('해제 중…', disconnectDrive)
      return withBusy('연결 중…', connectDrive) // 미연결·재연결 모두 동의 팝업(사용자 제스처)
    })
  })
  retryBtn.addEventListener('click', () => void withBusy('재시도 중…', drainDrive))
  cacheInput.addEventListener('change', () => {
    const n = Number(cacheInput.value)
    if (Number.isFinite(n) && n >= 1) void setDriveCacheLimit(n).then(() => refresh())
  })

  // 워커가 토큰 필요를 알리면 즉시 상태 갱신 (재연결 필요 표시)
  subscribe('_gdrive:needToken', () => void refresh())

  // 패널 열려 있는 동안 주기적 갱신 (대기열 배수 진행 반영)
  setInterval(() => {
    if (panel.classList.contains('open')) void refresh()
  }, 3000)

  void refresh()
}
