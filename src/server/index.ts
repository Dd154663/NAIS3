import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { decode, encode } from '@msgpack/msgpack'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcEvent, RpcInvoke, RpcReady, RpcResult } from '../web/rpc'
import { closeDb, initDb } from '../main/db'
import { getSetting } from '../main/db/settings'
import {
  getMemoryImage,
  isMemoryPath,
  isUnderImagesRoot,
  thumbnailByPath
} from '../main/images/storage'
import { registerIpcHandlers } from '../main/ipc'
import { GenerationQueue } from '../main/queue/generation-queue'
import { addEventSink } from './event-hub'
import { dispatch, registeredChannels } from './registry'
import { runGeneration } from './pipeline'
import { registerWebChannels } from './web-channels'
import { DATA_DIR } from './shims/electron'

/**
 * NAIS3 셀프호스트 서버 (P0) — "헤드리스 main 프로세스".
 * 데스크톱 main이 하는 일(DB·생성 큐·NAI 호출·이미지 저장)을 원본 모듈 그대로 Node에서
 * 돌리고, Electron IPC 대신 WebSocket으로 src/web/rpc.ts 프로토콜을 서빙한다.
 * 존재 이유: 예약 생성의 백그라운드 보장 — 브라우저(특히 iOS PWA)는 탭이 닫히면 죽지만
 * 서버 상주 큐는 계속 돈다.
 *
 * 환경변수:
 * - NAIS3_ACCESS_KEY  접속 키 (미설정 시 127.0.0.1 전용으로만 뜬다)
 * - NAIS3_PORT        기본 8787
 * - NAIS3_HOST        기본: 키 설정 시 0.0.0.0, 미설정 시 127.0.0.1
 * - NAIS3_DATA_DIR    DB·이미지·키 저장 루트 (기본 ~/.nais3-server)
 * - NAIS3_APP_ROOT    resources/ 위치 (기본 실행 디렉터리)
 */

const ACCESS_KEY = process.env.NAIS3_ACCESS_KEY ?? ''
const PORT = Number(process.env.NAIS3_PORT ?? 8787)
const HOST = process.env.NAIS3_HOST ?? (ACCESS_KEY ? '0.0.0.0' : '127.0.0.1')

function keyOk(url: URL): boolean {
  if (!ACCESS_KEY) return true // 키 미설정 = 루프백 전용 바인딩이 방어선
  return url.searchParams.get('key') === ACCESS_KEY
}

function boot(): void {
  const { version: dbVersion } = initDb()

  const queue = new GenerationQueue(runGeneration)
  const savedDelay = Number(getSetting('gen_delay_ms'))
  if (Number.isFinite(savedDelay) && savedDelay >= 0) queue.setDelayMs(savedDelay)

  registerIpcHandlers({ dbVersion, queue })
  registerWebChannels() // 웹 내부 채널(`_` 접두) — 브라우저 워커에만 있던 데이터 위임 채널을 서버에도 등록

  const http = createServer((req, res) => handleHttp(req, res))
  const wss = new WebSocketServer({ noServer: true })

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!keyOk(url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    const send = (msg: RpcResult | RpcEvent | RpcReady): void => {
      if (ws.readyState === ws.OPEN) ws.send(encode(msg))
    }

    // broadcast(queue:changed, generation:progress 등) → 이 소켓으로 중계
    const removeSink = addEventSink((channel, payload) => {
      send({ kind: 'event', channel, payload })
    })
    ws.on('close', removeSink)

    ws.on('message', (data: Buffer) => {
      let msg: RpcInvoke
      try {
        msg = decode(new Uint8Array(data)) as RpcInvoke
      } catch {
        return // 프로토콜 외 메시지는 무시
      }
      if (!msg || msg.kind !== 'invoke') return
      dispatch(msg.channel, msg.req)
        .then((value) => send({ kind: 'result', id: msg.id, ok: true, value }))
        .catch((e: unknown) => {
          send({
            kind: 'result',
            id: msg.id,
            ok: false,
            value: e instanceof Error ? e.message : String(e)
          })
        })
    })

    // 부팅 핸드셰이크 — 워커의 ready와 동일 (채널 목록은 커버리지 대조용)
    send({ kind: 'ready', dbVersion, channels: registeredChannels() })
  })

  http.listen(PORT, HOST, () => {
    console.log(
      `[server] NAIS3 서버 시작 — ws://${HOST}:${PORT} (채널 ${registeredChannels().length}개)`
    )
    console.log(`[server] 데이터: ${DATA_DIR}`)
    if (!ACCESS_KEY) {
      console.warn(
        '[server] NAIS3_ACCESS_KEY 미설정 — 루프백(127.0.0.1) 전용으로 동작합니다. ' +
          '외부(모바일)에서 접속하려면 키를 설정하세요.'
      )
    }
  })

  const shutdown = (): void => {
    console.log('[server] 종료 중…')
    http.close()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/** 데스크톱 nais-image:// 프로토콜의 HTTP 이식 + 헬스체크 */
function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }

  if (url.pathname === '/nais-image/' || url.pathname === '/nais-image') {
    if (!keyOk(url)) {
      res.writeHead(401).end('unauthorized')
      return
    }
    const filePath = decodeURIComponent(url.searchParams.get('path') ?? '')
    // 자동저장 OFF 임시 이미지 — 메모리 원본, 만료됐으면 DB 썸네일로 폴백 (데스크톱 동일)
    if (isMemoryPath(filePath)) {
      const buf = getMemoryImage(filePath)
      if (buf) {
        res.writeHead(200, { 'content-type': 'image/png' }).end(buf)
        return
      }
      const thumb = thumbnailByPath(filePath)
      if (thumb) {
        res.writeHead(200, { 'content-type': 'image/webp' }).end(thumb)
        return
      }
      res.writeHead(410).end('gone')
      return
    }
    if (!isUnderImagesRoot(filePath)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!existsSync(filePath)) {
      res.writeHead(404).end('not found')
      return
    }
    const type = filePath.endsWith('.webp')
      ? 'image/webp'
      : filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/png'
    res.writeHead(200, { 'content-type': type })
    createReadStream(filePath).pipe(res)
    return
  }

  // 정적 프론트 서빙은 P1 (혼합 콘텐츠 회피 — 서버가 웹앱도 함께 서빙 예정)
  res.writeHead(404).end('not found')
}

boot()
