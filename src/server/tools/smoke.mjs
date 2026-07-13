/**
 * 서버 스모크 테스트 — WS로 rpc.ts 프로토콜을 실제 호출해 P0 골격을 검증한다.
 * 사용: node dist 서버를 띄운 뒤  node src/server/tools/smoke.mjs [ws://127.0.0.1:8787] [key]
 * 검증 항목: ready 핸드셰이크, 대표 채널 invoke, 미등록 채널 에러, 큐 enqueue→이벤트 수신.
 * (NAI 토큰 없이 돌므로 생성은 '토큰 미설정' 실패가 정상 — 실패 이벤트 수신까지가 검증 대상)
 */
import WebSocket from 'ws'
import { decode, encode } from '@msgpack/msgpack'

const base = process.argv[2] ?? 'ws://127.0.0.1:8787'
const key = process.argv[3] ?? process.env.NAIS3_ACCESS_KEY ?? ''
const url = key ? `${base}/?key=${encodeURIComponent(key)}` : base

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'

let nextId = 1
const pending = new Map()
const events = []
let ready = null
let readyResolve
const readyPromise = new Promise((r) => (readyResolve = r))

ws.on('message', (data) => {
  const msg = decode(new Uint8Array(data))
  if (msg.kind === 'ready') {
    ready = msg
    readyResolve()
  } else if (msg.kind === 'result') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.ok ? p.resolve(msg.value) : p.reject(new Error(String(msg.value)))
  } else if (msg.kind === 'event') {
    events.push(msg)
  }
})

function invoke(channel, req) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(encode({ kind: 'invoke', id, channel, req }))
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

ws.on('open', async () => {
  try {
    await readyPromise
    check(
      'ready 핸드셰이크',
      ready.dbVersion >= 1 && ready.channels.length > 100,
      `dbVersion=${ready.dbVersion}, 채널 ${ready.channels.length}개`
    )

    const ver = await invoke('app:version', undefined)
    check('app:version', typeof ver.version === 'string', ver.version)

    const db = await invoke('db:status', undefined)
    check('db:status', typeof db.path === 'string', db.path)

    const tok = await invoke('nai:tokenStatus', undefined)
    check('nai:tokenStatus', tok.hasToken === false, 'hasToken=false (신규 DB)')

    await invoke('settings:set', { key: 'smoke_test', value: 'hello' })
    const got = await invoke('settings:get', { key: 'smoke_test' })
    check('settings 왕복', got.value === 'hello')

    const chars = await invoke('chars:list', undefined)
    check('chars:list', chars !== null && typeof chars === 'object')

    const tags = await invoke('tags:search', { query: '1girl', limit: 5 })
    check(
      'tags:search (resources 로드)',
      Array.isArray(tags.items) && tags.items.length > 0,
      tags.items?.[0]?.tag ?? ''
    )

    let unknownRejected = false
    try {
      await invoke('nope:nothing', {})
    } catch (e) {
      unknownRejected = /등록되지 않은 채널/.test(e.message)
    }
    check('미등록 채널 거부', unknownRejected)

    // 큐: 토큰 없는 상태의 enqueue → failed 전이 + queue:changed 이벤트 수신이 검증 대상
    const req = {
      prompt: 'smoke test',
      negativePrompt: '',
      model: 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      steps: 28,
      cfgScale: 5,
      cfgRescale: 0,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      seed: 1234,
      variety: false,
      qualityToggle: true,
      ucPreset: 0,
      characterPrompts: [],
      useCoords: false
    }
    const { ids } = await invoke('queue:enqueue', { request: req, count: 1 })
    check('queue:enqueue', Array.isArray(ids) && ids.length === 1)

    await new Promise((r) => setTimeout(r, 1500))
    const status = await invoke('queue:status', undefined)
    const item = status.items.find((i) => i.id === ids[0])
    check(
      '큐 실행 → 실패 전이 (토큰 없음)',
      item?.state === 'failed' && /토큰/.test(item?.error ?? ''),
      item?.error ?? item?.state
    )

    const queueEvents = events.filter((e) => e.channel === 'queue:changed')
    check('queue:changed 이벤트 수신', queueEvents.length >= 2, `${queueEvents.length}회`)

    const failed = results.filter((r) => !r.ok)
    console.log(failed.length ? `\n${failed.length}개 실패` : '\n스모크 전체 통과')
    process.exit(failed.length ? 1 : 0)
  } catch (e) {
    console.error('스모크 실행 오류:', e)
    process.exit(1)
  }
})

ws.on('error', (e) => {
  console.error('WS 연결 실패:', e.message)
  process.exit(1)
})
