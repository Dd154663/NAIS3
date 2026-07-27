/**
 * NAIS3 웹 서비스워커.
 * 1) /nais-image/?path=... 를 IndexedDB('nais3-web')에서 서빙 — Electron의
 *    nais-image:// 커스텀 프로토콜(src/main/index.ts protocol.handle)의 웹 대응.
 *    스토어 구조는 src/web/backend/idb.ts와 공유한다 (files/thumbs: { bytes, mime }).
 * 2) 앱 셸 프리캐시 — 오프라인 콜드 스타트. 아래 __PRECACHE__는 빌드 시
 *    vite 플러그인(nais-web:sw-precache)이 에셋 목록으로 치환한다. dev에선 null(생략).
 *    tags.json(16MB)은 의도적으로 프리캐시 제외 — 지연 로드 유지.
 */

self.__PRECACHE__ = null

const IDB_NAME = 'nais3-web'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  const pre = self.__PRECACHE__
  if (pre) {
    event.waitUntil(caches.open(pre.version).then((cache) => cache.addAll(pre.assets)))
  }
})

self.addEventListener('activate', (event) => {
  const pre = self.__PRECACHE__
  event.waitUntil(
    (async () => {
      // 이전 버전 캐시 정리
      for (const key of await caches.keys()) {
        if (!pre || key !== pre.version) await caches.delete(key)
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  // base 하위 배포(GitHub Pages 등) 대응 — SW scope에서 base 경로를 얻는다 (예: /NAIS3/)
  const basePath = new URL(self.registration.scope).pathname

  if (url.pathname === `${basePath}nais-image/`) {
    const path = decodeURIComponent(url.searchParams.get('path') || '')
    event.respondWith(serveImage(path))
    return
  }

  const pre = self.__PRECACHE__
  if (!pre || event.request.method !== 'GET') return

  // 내비게이션: network-first, 오프라인이면 캐시된 앱 셸
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches
          .open(pre.version)
          .then((cache) => cache.match(`${basePath}index.html`))
          .then((hit) => hit || new Response('offline', { status: 503 }))
      )
    )
    return
  }

  // 프리캐시 에셋: cache-first (파일명이 콘텐츠 해시라 안전)
  if (pre.assets.includes(url.pathname)) {
    event.respondWith(
      caches.open(pre.version).then((cache) =>
        cache.match(event.request).then(
          (hit) =>
            hit ||
            fetch(event.request).then((res) => {
              if (res.ok) cache.put(event.request, res.clone())
              return res
            })
        )
      )
    )
  }
})

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve(undefined)
    const req = db.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function serveImage(path) {
  try {
    const db = await openDb()
    const file = await idbGet(db, 'files', path)
    if (file && file.bytes) {
      return new Response(file.bytes, { headers: { 'content-type': file.mime || 'image/png' } })
    }
    // 원본 만료(자동저장 OFF 세션 종료) — 썸네일 폴백 (데스크톱 프로토콜과 동일)
    const thumb = await idbGet(db, 'thumbs', path)
    if (thumb && thumb.bytes) {
      return new Response(thumb.bytes, { headers: { 'content-type': thumb.mime || 'image/webp' } })
    }
    return new Response('gone', { status: 410 })
  } catch (e) {
    return new Response(`error: ${e}`, { status: 500 })
  }
}
