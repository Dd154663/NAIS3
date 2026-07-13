/**
 * 서버 invoke 레지스트리 — Electron ipcMain.handle의 저장소 대응.
 * electron 심의 ipcMain.handle이 여기 등록하고, WS 계층이 dispatch로 호출한다.
 * (src/web/bus.ts의 워커 쪽 역할과 동일 — 서버는 DOM 채널이 없어 더 단순)
 */

type Handler = (event: unknown, req: unknown) => unknown

const handlers = new Map<string, Handler>()

export function register(channel: string, handler: Handler): void {
  if (handlers.has(channel)) throw new Error(`중복 핸들러 등록: ${channel}`)
  handlers.set(channel, handler)
}

export function hasChannel(channel: string): boolean {
  return handlers.has(channel)
}

export function registeredChannels(): string[] {
  return [...handlers.keys()]
}

export async function dispatch(channel: string, req: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`등록되지 않은 채널: ${channel}`)
  return handler({}, req)
}
