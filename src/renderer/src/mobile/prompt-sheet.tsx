import {
  ChevronDown,
  ChevronUp,
  ImageUp,
  Layers,
  Puzzle,
  UsersRound,
  type LucideIcon
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button'

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

/** 도구 행 — 데스크톱 프롬프트 패널과 동일한 4버튼 (파라미터는 생성 바의 ⚙) */
type ToolId = 'char' | 'frag' | 'vibe' | 'cref'
const TOOLS: { id: ToolId; label: string; icon: LucideIcon }[] = [
  { id: 'char', label: '캐릭터', icon: UsersRound },
  { id: 'frag', label: '조각', icon: Puzzle },
  { id: 'vibe', label: '바이브', icon: Layers },
  { id: 'cref', label: '레퍼런스', icon: ImageUp }
]

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
        <SheetBody />
      </motion.div>
    </div>
  )
}

/**
 * 시트 내부 — 데스크톱 프롬프트 패널과 동일한 골격:
 * 프롬프트 영역(오버레이는 이 영역만 위로 덮음) + 하단 도구 행(항상 접근 가능).
 */
function SheetBody(): React.JSX.Element {
  // 도구 오버레이는 한 번에 하나만 — 재탭으로 닫힘 (데스크톱 only()와 동일)
  const [tool, setTool] = useState<ToolId | null>(null)
  const active = TOOLS.find((t) => t.id === tool)

  return (
    <div className="flex h-full flex-col gap-2 px-3 pb-3">
      {/* 오버레이는 프롬프트 영역만 덮는다 — 하단 도구 행은 항상 접근 가능 (데스크톱과 동일) */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-2">
        {/* 목업 — 다음 차수에서 실제 배선 */}
        <SheetLabel>프롬프트</SheetLabel>
        <textarea
          placeholder="프롬프트"
          className="min-h-16 w-full flex-1 resize-none rounded-md border border-line bg-paper p-2 text-[13px] text-ink outline-none placeholder:text-faint"
        />
        {/* 목업 — 다음 차수에서 실제 배선 */}
        <SheetLabel>네거티브</SheetLabel>
        <textarea
          placeholder="네거티브"
          className="min-h-16 w-full resize-none rounded-md border border-line bg-paper p-2 text-[13px] text-ink outline-none placeholder:text-faint"
        />
        <AnimatePresence>
          {active && (
            <motion.div
              key="tool-overlay"
              className="absolute -inset-1 z-10 flex flex-col gap-2 rounded-lg bg-surface p-2"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.18, ease: EASE }}
            >
              {/* 목업 — 다음 차수에서 실제 배선 (데스크톱 CharacterOverlay 등 재사용) */}
              <div className="flex h-9 shrink-0 items-center gap-2 px-1 text-[13px] font-medium text-ink">
                <active.icon size={14} />
                {active.label}
              </div>
              <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="h-20 rounded-md bg-surface-2" />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 도구 행: 캐릭터 / 조각 / 바이브 / 레퍼런스 — 탭하면 위 오버레이, 재탭으로 닫힘 */}
      <div className="grid shrink-0 grid-cols-4 gap-1.5">
        {TOOLS.map((t) => (
          <ToolButton
            key={t.id}
            active={tool === t.id}
            icon={<t.icon size={14} />}
            label={t.label}
            onClick={() => setTool((v) => (v === t.id ? null : t.id))}
          />
        ))}
      </div>
    </div>
  )
}

function SheetLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="shrink-0 text-[12px] font-medium text-muted">{children}</div>
}

/** 데스크톱 프롬프트 패널 ToolButton과 동형 — 높이만 모바일 탭 타깃(44px) */
function ToolButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      variant={active ? 'default' : 'ghost'}
      className="h-11 w-full min-w-0 gap-1 px-1.5 text-[12px]"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}
