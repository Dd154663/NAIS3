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
.nais3-gd-head-btns { display: flex; align-items: center; gap: 6px; }
.nais3-gd-help { background: none; border: 1px solid var(--line); border-radius: 6px;
  color: var(--muted); cursor: pointer; font-size: 12px; padding: 2px 8px; }
.nais3-gd-help:hover { background: var(--surface-2); }
#nais3-gd-overlay {
  position: fixed; inset: 0; z-index: 2147483100; background: rgba(0,0,0,.5);
  display: none; align-items: center; justify-content: center; padding: 20px;
}
#nais3-gd-overlay.open { display: flex; }
#nais3-gd-guide {
  background: var(--paper); color: var(--ink); border: 1px solid var(--line);
  border-radius: var(--radius); max-width: 560px; width: 100%; max-height: 85vh; overflow-y: auto;
  padding: 20px 22px; font-family: var(--font-ui); box-shadow: 0 12px 40px rgba(0,0,0,.4);
}
#nais3-gd-guide h2 { font-size: 16px; margin: 0; }
#nais3-gd-guide h4 { font-size: 13px; margin: 18px 0 6px; color: var(--accent); }
#nais3-gd-guide p, #nais3-gd-guide li { font-size: 13px; line-height: 1.65; }
#nais3-gd-guide ol, #nais3-gd-guide ul { margin: 4px 0; padding-left: 20px; }
#nais3-gd-guide code { font-family: var(--font-mono); font-size: 12px; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
#nais3-gd-guide .muted { color: var(--muted); font-size: 12px; }
#nais3-gd-guide a { color: var(--accent); }
`

// 정적 도움말 콘텐츠 (사용자 입력 없음 — innerHTML 안전)
const GUIDE_HTML = `
<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
  <h2>Google Drive 저장 가이드</h2>
  <button data-close class="nais3-gd-x" aria-label="닫기">✕</button>
</div>
<p class="muted">생성한 이미지 원본을 내 Google Drive에 보관하고, 기기에는 최근 것만 캐시합니다.</p>

<h4>어떻게 동작하나요</h4>
<ul>
  <li>원본은 Drive의 <code>NAIS3/연-월/</code> 폴더에 업로드됩니다.</li>
  <li>기기(브라우저)에는 <b>최근 N장</b>만 풀해상도로 캐시하고, 나머지는 필요할 때 Drive에서 불러옵니다. 매수는 패널에서 조절할 수 있습니다.</li>
  <li>썸네일(목록용)은 항상 기기에 남아 목록은 오프라인에서도 보입니다.</li>
  <li>오프라인이거나 업로드가 실패해도 <b>생성은 성공</b>합니다 — 대기열에 쌓아 두었다가 온라인이 되면 자동 업로드합니다.</li>
</ul>

<h4>권한 · 개인정보</h4>
<ul>
  <li>권한 범위는 <code>drive.file</code> 하나 — <b>이 앱이 만든 파일만</b> 접근합니다. Drive의 다른 파일은 보이지 않습니다.</li>
  <li>로그인 토큰은 이 브라우저 세션에만 있고 저장되지 않습니다. 새로고침하면 패널에서 다시 연결해야 합니다.</li>
</ul>

<h4>처음 설정하기 (배포자용)</h4>
<p class="muted">이미 설정된 사이트를 쓰는 경우엔 패널의 "연결" 버튼만 누르면 됩니다. 아래는 직접 포크·배포할 때 필요한 준비입니다.</p>
<ol>
  <li><b>Google Cloud 프로젝트</b>를 만들고 <b>API 및 서비스 → 라이브러리</b>에서 <code>Google Drive API</code>를 <b>사용 설정</b>합니다. (빠뜨리면 로그인은 되지만 모든 요청이 403이 됩니다.)</li>
  <li><b>OAuth 동의 화면</b>: 외부(External), 범위에 <code>.../auth/drive.file</code>만 추가. 만료·테스트 제한을 피하려면 <b>앱 게시(프로덕션)</b> 권장(비민감 범위라 심사 불요).</li>
  <li><b>사용자 인증 정보 → OAuth 클라이언트 ID → 웹 애플리케이션</b>. 승인된 JavaScript 원본에 배포 도메인과 <code>http://localhost:5173</code> 추가. 리디렉션 URI는 비워도 됩니다.</li>
  <li>발급된 <b>클라이언트 ID</b>를 빌드에 주입: 로컬은 프로젝트 루트 <code>.env.local</code>의 <code>VITE_GDRIVE_CLIENT_ID</code>, 배포는 GitHub 저장소 변수 <code>GDRIVE_CLIENT_ID</code>.</li>
</ol>
<p class="muted">클라이언트 ID는 브라우저에 노출되는 공개 식별자라 비밀이 아닙니다.</p>

<h4>주의 · 문제 해결</h4>
<ul>
  <li><b>한 번에 한 탭</b>에서만 여세요 — 같은 브라우저의 다른 탭에서 앱을 열면 저장소 접근이 충돌할 수 있습니다.</li>
  <li><b>연결 팝업이 안 뜰 때</b>: 브라우저의 팝업 차단을 해제하세요. 연결은 반드시 패널의 버튼 클릭으로 시작해야 합니다.</li>
  <li><b>"Drive 오류 403 … API … disabled"</b>: 위 1번(Drive API 사용 설정)이 안 된 상태입니다.</li>
</ul>
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
  const headBtns = document.createElement('div')
  headBtns.className = 'nais3-gd-head-btns'
  const helpBtn = document.createElement('button')
  helpBtn.className = 'nais3-gd-help'
  helpBtn.textContent = '도움말'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'nais3-gd-x'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', '닫기')
  headBtns.append(helpBtn, closeBtn)
  header.append(title, headBtns)

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

  // ── 도움말 모달 (설정·사용 가이드) ─────────────────────────
  const overlay = document.createElement('div')
  overlay.id = 'nais3-gd-overlay'
  const guide = document.createElement('div')
  guide.id = 'nais3-gd-guide'
  guide.innerHTML = GUIDE_HTML
  overlay.append(guide)
  document.body.append(overlay)

  const closeGuide = (): void => overlay.classList.remove('open')
  helpBtn.addEventListener('click', () => overlay.classList.add('open'))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeGuide() // 배경 클릭으로 닫기
  })
  guide.querySelector('[data-close]')?.addEventListener('click', closeGuide)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeGuide()
  })

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
