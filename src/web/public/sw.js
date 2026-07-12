/**
 * NAIS3 웹 서비스워커.
 * 역할: /nais-image/?path=... 를 IndexedDB('nais3-web')에서 서빙 — Electron의
 * nais-image:// 커스텀 프로토콜(src/main/index.ts protocol.handle)의 웹 대응.
 * 스토어 구조는 src/web/backend/idb.ts와 공유한다 (files/thumbs: { bytes, mime }).
 */

const IDB_NAME = 'nais3-web'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // base 하위 배포(GitHub Pages 등) 대응 — SW scope에서 base 경로를 얻는다 (예: /NAIS3/)
  const basePath = new URL(self.registration.scope).pathname
  if (url.origin === self.location.origin && url.pathname === `${basePath}nais-image/`) {
    const path = decodeURIComponent(url.searchParams.get('path') || '')
    event.respondWith(serveImage(path))
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
