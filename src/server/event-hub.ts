/**
 * 서버 이벤트 허브 — Electron의 webContents.send에 대응.
 * electron 심의 가짜 BrowserWindow가 여기로 흘리고, WS 계층이 접속 소켓들로 중계한다.
 */

type EventSink = (channel: string, payload: unknown) => void

const sinks = new Set<EventSink>()

export function addEventSink(sink: EventSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

export function emitEvent(channel: string, payload: unknown): void {
  for (const sink of sinks) sink(channel, payload)
}
