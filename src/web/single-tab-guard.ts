/**
 * 단일 탭 가드 (잠정) — opfs-sahpool VFS는 단일 연결만 허용한다. 같은 브라우저에서 2번째 탭을
 * 열면 워커가 OPFS 동기 핸들 충돌(NoModificationAllowedError)로 조용히 죽는다.
 * Web Locks로 먼저 감지해, 2번째 탭은 워커를 만들지 않고 안내 화면만 띄운다.
 *
 * 참고: 이 제약을 없애 진짜 다중 탭을 열려면 VFS를 opfs-wl(Web Locks 기반, COOP/COEP 불필요,
 * 다중 탭 동시성)로 교체해야 한다 — 조사 완료·보류 중(플랜 리스크 메모 참조). 그때 이 가드는 제거.
 * 다른 기기(PC↔모바일)는 저장소가 분리돼 애초에 충돌하지 않으므로 이 가드와 무관하다.
 */

const LOCK = 'nais3-opfs-db'

/**
 * 이 탭이 주(유일) 탭이면 true, 다른 탭이 이미 점유 중이면 false.
 * navigator.locks 미지원 브라우저는 통과(true) — 기존 동작 유지.
 * 획득 시 락은 탭 생명주기 동안 유지된다(페이지 종료 시 자동 해제).
 */
export function acquireSingleTabLock(): Promise<boolean> {
  const locks = navigator.locks
  if (!locks?.request) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    locks
      .request(LOCK, { mode: 'exclusive', ifAvailable: true }, (lock): Promise<never> | undefined => {
        resolve(lock !== null)
        if (!lock) return undefined // 보조 탭 — 락을 잡지 않고 콜백 종료
        return new Promise<never>(() => {}) // 주 탭 — 탭이 닫힐 때까지 락 유지
      })
      .catch(() => resolve(true)) // 오류 시 기존 동작 유지
  })
}

/** 2번째 탭 안내 — 앱 테마 변수 재사용, 새로고침 버튼 제공 */
export function showMultiTabNotice(): void {
  const wrap = document.createElement('div')
  wrap.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483200',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
    'background:var(--paper)',
    'color:var(--ink)',
    'font-family:var(--font-ui)'
  ].join(';')

  const card = document.createElement('div')
  card.style.cssText = 'max-width:360px;text-align:center'

  const h = document.createElement('h1')
  h.textContent = '다른 탭에서 실행 중'
  h.style.cssText = 'font-size:18px;font-weight:600;margin:0 0 10px'

  const p = document.createElement('p')
  p.textContent =
    'NAIS3는 한 번에 하나의 탭에서만 열 수 있습니다. 다른 탭을 닫은 뒤 새로고침하세요.'
  p.style.cssText = 'font-size:14px;line-height:1.65;color:var(--muted);margin:0 0 18px'

  const btn = document.createElement('button')
  btn.textContent = '새로고침'
  btn.style.cssText =
    'padding:9px 18px;border-radius:8px;border:1px solid var(--accent);' +
    'background:var(--accent);color:#fff;font-size:14px;cursor:pointer'
  btn.addEventListener('click', () => window.location.reload())

  card.append(h, p, btn)
  wrap.append(card)
  document.body.append(wrap)
}
