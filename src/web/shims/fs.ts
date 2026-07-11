/**
 * fs shim — 웹에서 재사용하는 src/main 모듈(tags/tokenizer/repo류)이 import하는 이름만 제공.
 * readFileSync는 사전에 등록된 가상 파일(리소스 JSON)만 지원하고, 나머지는 호출 시 명확히 실패한다
 * (import 자체는 성공해야 하므로 throw는 호출 시점에).
 */

const virtualFiles = new Map<string, string>()

/** 웹 백엔드가 fetch로 받아온 리소스를 동기 readFileSync 경로에 등록 */
export function __registerVirtualFile(path: string, content: string): void {
  virtualFiles.set(path.replace(/\\/g, '/'), content)
}

export function readFileSync(path: string, _encoding?: unknown): string {
  const found = virtualFiles.get(String(path).replace(/\\/g, '/'))
  if (found === undefined) {
    throw new Error(`[web] readFileSync는 사전 등록된 리소스만 지원합니다: ${path}`)
  }
  return found
}

function unsupported(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`[web] fs.${name}은 웹에서 지원되지 않습니다`)
  }
}

export const writeFileSync = unsupported('writeFileSync')
export const mkdirSync = unsupported('mkdirSync')
export const copyFileSync = unsupported('copyFileSync')
export const unlinkSync = unsupported('unlinkSync')
export const rmSync = unsupported('rmSync')
export const readdirSync = unsupported('readdirSync')
export const createWriteStream = unsupported('createWriteStream')
export const existsSync = (_path: string): boolean => false
