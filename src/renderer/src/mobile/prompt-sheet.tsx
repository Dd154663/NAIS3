import { ChevronDown, ChevronUp } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { PromptPanel } from '../components/prompt-panel'

export type SheetSnap = 'closed' | 'mid' | 'full'

/** 스냅 판정 임계 이동량(px) — 이보다 적게 움직이면 탭으로 본다 */
const DRAG_THRESHOLD = 40
/** 핸들 높이 = 모바일 탭 타깃(44px) */
export const SHEET_HANDLE_HEIGHT = 44
/**
 * full 스냅에서 비워두는 세로 공간: 상단 바(56) + 핸들(44) + 생성 바(57) + 콘텐츠 여백·경계(9).
 * 값이 어긋나도 시트 자체가 flex에서 줄어들 수 있으므로(아래 min-h-0) 생성 바가 화면 밖으로
 * 밀리는 일은 없다 — 이 상수는 "딱 맞게" 열기 위한 값이다.
 */
const RESERVED = 166
/** 중간 스냅 높이 비율 — 프롬프트 영역이 보이는 고정 높이 */
const MID_RATIO = 0.52

const EASE = [0.22, 1, 0.36, 1] as const

function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 844 : window.innerHeight))
  useEffect(() => {
    const onResize = (): void => setH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return h
}

/**
 * 프롬프트 하단 시트 (3스냅: closed / mid / full).
 *
 * 핸들 탭 → mid, 핸들 위로 드래그 → full, 아래로 드래그 → full은 mid, mid는 closed.
 * 어느 스냅에서도 생성 바는 시트 아래 그대로 고정된다(불변 조건) — 시트는 플렉스 컬럼의
 * 생성 바 바로 위 형제이므로 위치가 보장된다.
 *
 * 설정 `ui_mobile_sheet_thirds`("프롬프트 3분할")로 mid를 가변 높이로 여는 것은 다음 차수.
 */
export function PromptSheet({
  snap,
  onSnapChange
}: {
  snap: SheetSnap
  onSnapChange: (snap: SheetSnap) => void
}): React.JSX.Element {
  const vh = useViewportHeight()
  const mid = Math.round(vh * MID_RATIO)
  const full = Math.max(mid, vh - RESERVED)
  const height = snap === 'closed' ? 0 : snap === 'mid' ? mid : full
  const startY = useRef<number | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    startY.current = e.clientY
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const from = startY.current
    startY.current = null
    if (from === null) return
    const dy = e.clientY - from
    if (dy <= -DRAG_THRESHOLD) onSnapChange('full')
    else if (dy >= DRAG_THRESHOLD) onSnapChange(snap === 'full' ? 'mid' : 'closed')
    else onSnapChange(snap === 'closed' ? 'mid' : 'closed') // 탭
  }

  return (
    <div className="flex min-h-0 flex-col rounded-t-xl border-t border-line bg-surface">
      <button
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (startY.current = null)}
        title={snap === 'closed' ? '프롬프트 열기 (위로 끌면 전체)' : '프롬프트 닫기'}
        className="flex w-full shrink-0 touch-none items-center justify-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-ink"
        style={{ height: SHEET_HANDLE_HEIGHT }}
      >
        {snap === 'closed' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        프롬프트
      </button>
      <motion.div
        className="min-h-0 overflow-hidden"
        initial={false}
        animate={{ height }}
        transition={{ duration: 0.22, ease: EASE }}
      >
        {/* 데스크톱 좌측 패널을 그대로 삽입 — 프리셋 바·프롬프트·도구 오버레이·전부 실배선.
            생성 행만 embedded로 빠지고 셸의 생성 바(GenerateRow 재사용)가 대신한다 */}
        <PromptPanel embedded />
      </motion.div>
    </div>
  )
}
