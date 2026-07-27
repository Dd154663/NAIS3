/**
 * 서버 스모크 테스트 — WS로 rpc.ts 프로토콜을 실제 호출해 P0 골격을 검증한다.
 * 사용: node dist 서버를 띄운 뒤  node src/server/tools/smoke.mjs [ws://127.0.0.1:8787] [key]
 * 검증 항목: ready 핸드셰이크, 대표 채널 invoke, 미등록 채널 에러, 큐 enqueue→이벤트 수신.
 * (NAI 토큰 없이 돌므로 생성은 '토큰 미설정' 실패가 정상 — 실패 이벤트 수신까지가 검증 대상)
 */
import WebSocket from 'ws'
import { decode, encode } from '@msgpack/msgpack'
import sharp from 'sharp'

/** 테스트용 초소형 PNG 바이트 (Uint8Array — msgpack bin으로 전송) */
async function smallPng() {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 50, b: 50 } }
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

/** msgpack bin으로 온 ZIP 바이트인지 — 로컬 파일 헤더 시그니처(PK\x03\x04) 확인 */
function isZipBytes(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

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

    // ── 웹 내부 채널(`_` 접두) — 서버 이식분 검증 ──────────────
    // 조각 txt 넣고 → 내보내기 왕복
    const fragImp = await invoke('_frags:importTxts', {
      files: [{ name: 'smoke-frag.txt', text: '조각 내용 42' }]
    })
    check('_frags:importTxts', fragImp.count === 1)
    const fragList = await invoke('frags:list', undefined)
    const frag = fragList.items.find((f) => f.name === 'smoke-frag')
    const fragExp = frag ? await invoke('_frags:exportData', { id: frag.id }) : null
    check(
      '_frags:exportData 왕복',
      !!fragExp && fragExp.name === 'smoke-frag' && fragExp.content === '조각 내용 42',
      fragExp?.content ?? '행 없음'
    )

    // 조각 전체 ZIP — bytes는 msgpack bin(Uint8Array)으로 오고, PK\x03\x04 시그니처면 정상 ZIP
    const fragZip = await invoke('_frags:exportAllZip', undefined)
    check(
      '_frags:exportAllZip',
      fragZip.count >= 1 && isZipBytes(fragZip.bytes),
      `조각 ${fragZip.count}개 / ${fragZip.bytes?.length ?? 0}바이트`
    )

    // 백업 내보내기 → 파싱/주요 키 → 재주입
    const backupJson = await invoke('_backup:exportJson', undefined)
    let backup = null
    try {
      backup = JSON.parse(backupJson)
    } catch {
      backup = null
    }
    check(
      '_backup:exportJson 파싱/키',
      !!backup &&
        backup._app === 'NAIS3' &&
        backup._version === 1 &&
        backup.tables &&
        Array.isArray(backup.tables.fragments),
      backup ? `테이블 ${Object.keys(backup.tables).length}개` : 'parse 실패'
    )
    const backupImp = await invoke('_backup:importJson', { text: backupJson })
    check(
      '_backup:importJson 재주입',
      typeof backupImp.summary === 'string' && /복원 완료/.test(backupImp.summary),
      backupImp.summary ?? backupImp.error
    )

    // 씬 JSON 가져오기 → 내보내기 형태 확인
    const preset = await invoke('scenePresets:create', { name: 'smoke-preset' })
    const scImp = await invoke('_scenes:importJsonText', {
      presetId: preset.id,
      text: JSON.stringify({ scenes: [{ name: 's1', prompt: 'p1', width: 640, height: 640 }] })
    })
    check('_scenes:importJsonText', scImp.count === 1)
    const scJson = await invoke('_scenes:exportJsonData', { presetId: preset.id })
    let scData = null
    try {
      scData = JSON.parse(scJson)
    } catch {
      scData = null
    }
    check(
      '_scenes:exportJsonData 형태',
      !!scData &&
        scData.version === 1 &&
        Array.isArray(scData.scenes) &&
        scData.scenes.length === 1 &&
        scData.scenes[0].name === 's1' &&
        scData.scenes[0].negativePrompt === '',
      scData ? `씬 ${scData.scenes.length}개` : 'parse 실패'
    )

    // 씬 ZIP — 스모크 DB엔 생성 이미지가 없으므로 "담을 게 없으면 count 0 + bytes null" 계약 확인.
    // (이름은 프리셋명_타임스탬프 / bulk는 빈 배열이면 빈 이름 — 워커와 동일)
    const scZip = await invoke('_scenes:exportZipData', { presetId: preset.id })
    check(
      '_scenes:exportZipData 형태',
      scZip.count === 0 && scZip.bytes === null && /^smoke-preset_\d+\.zip$/.test(scZip.name),
      scZip.name
    )
    const scBulkEmpty = await invoke('_scenes:bulkExportZipData', { ids: [] })
    check(
      '_scenes:bulkExportZipData 빈 선택',
      scBulkEmpty.count === 0 && scBulkEmpty.name === '' && scBulkEmpty.bytes === null
    )
    const scList = await invoke('scenes:list', { presetId: preset.id })
    const scIds = (scList.items ?? []).map((s) => s.id)
    const scBulk = await invoke('_scenes:bulkExportZipData', { ids: scIds })
    check(
      '_scenes:bulkExportZipData 왕복',
      scBulk.count === 0 && scBulk.bytes === null && /^scenes_\d+\.zip$/.test(scBulk.name),
      `씬 ${scIds.length}개 → ${scBulk.name}`
    )

    // _images:readBytes — 루트 밖/없는 경로는 null (nais-image 서빙과 동일 안전 규칙)
    const outside = await invoke('_images:readBytes', { filePath: '/etc/passwd' })
    const memNone = await invoke('_images:readBytes', { filePath: 'memory://nope' })
    check('_images:readBytes 루트 밖/없음 → null', outside === null && memNone === null)

    // 캐릭터 썸네일 — 작은 PNG로 설정
    const chr = await invoke('chars:create', { name: 'smoke-char', folderId: null })
    const setThumb = await invoke('_chars:setThumbnail', { id: chr.id, bytes: await smallPng() })
    check(
      '_chars:setThumbnail',
      typeof setThumb.thumbnail === 'string' && setThumb.thumbnail.length > 0,
      `base64 ${setThumb.thumbnail?.length ?? 0}자`
    )

    // 바이브/라이브러리 파일 추가
    const refAdd = await invoke('_refs:addFiles', {
      kind: 'vibe',
      folderId: null,
      files: [{ name: 'smoke-vibe.png', mime: 'image/png', bytes: await smallPng() }]
    })
    check('_refs:addFiles', refAdd.count === 1)
    const libAdd = await invoke('_library:importFiles', {
      files: [{ name: 'smoke-lib.png', bytes: await smallPng() }],
      stackId: null
    })
    check('_library:importFiles', libAdd.count === 1)

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
