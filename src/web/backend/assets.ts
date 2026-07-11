import { __registerVirtualFile } from '../shims/fs'

/**
 * 대용량 리소스(tags.json 16MB, t5_tokenizer.json 2.4MB)의 지연 로드.
 * src/main의 tags.ts/tokenizer.ts는 readFileSync로 동기 로드하므로,
 * 채널 핸들러가 먼저 ensureResource()로 fetch해 fs shim에 등록해 둔다.
 * 경로는 electron shim의 app.getAppPath()='/app' + 'resources/<name>'과 일치해야 한다.
 */

const loaded = new Set<string>()
const pending = new Map<string, Promise<void>>()

export function ensureResource(name: 't5_tokenizer.json' | 'tags.json'): Promise<void> {
  if (loaded.has(name)) return Promise.resolve()
  const existing = pending.get(name)
  if (existing) return existing

  const p = (async () => {
    const res = await fetch(`/${name}`)
    if (!res.ok) throw new Error(`리소스 로드 실패: /${name} (${res.status})`)
    __registerVirtualFile(`/app/resources/${name}`, await res.text())
    loaded.add(name)
    pending.delete(name)
  })()
  pending.set(name, p)
  return p
}
