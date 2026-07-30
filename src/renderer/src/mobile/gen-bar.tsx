import { History, Minus, Plus, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../lib/utils'
import { Button } from '../components/ui/button'

/**
 * 하단 고정 생성 바 (메인 모드 소유) — 데스크톱 프롬프트 패널 하단 바와 동형 +
 * 히스토리 버튼. [파라미터] [− n +] [생성] [히스토리].
 *
 * 파라미터·생성은 이번 차수에서 no-op(디자인 검수용 셸).
 */
export function GenBar({
  historyOpen,
  onToggleHistory
}: {
  historyOpen: boolean
  onToggleHistory: () => void
}): React.JSX.Element {
  // 목업 — 다음 차수에서 실제 배선 (데스크톱 batchCount 스테퍼)
  const [count, setCount] = useState(1)
  const clamp = (n: number): number => Math.max(1, Math.min(99, n))

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-line bg-paper px-2 pt-2"
      style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
    >
      {/* 목업 — 다음 차수에서 실제 배선 (ParamsDialog 열기) */}
      <Button size="icon" variant="ghost" className="h-10 w-11 shrink-0" title="생성 파라미터">
        <SlidersHorizontal size={16} />
      </Button>

      {/* 목업 — 다음 차수에서 실제 배선 (generation-store batchCount) */}
      <div className="flex h-10 shrink-0 items-center rounded-md border border-line bg-paper">
        <Button
          size="icon"
          variant="ghost"
          className="h-full w-9 rounded-r-none"
          aria-label="수량 감소"
          onClick={() => setCount((n) => clamp(n - 1))}
        >
          <Minus size={13} />
        </Button>
        <input
          className="w-8 bg-transparent text-center font-mono text-[13px] text-ink outline-none"
          value={count}
          inputMode="numeric"
          onChange={(e) => {
            const n = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10)
            if (!Number.isNaN(n)) setCount(clamp(n))
          }}
          onFocus={(e) => e.target.select()}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-full w-9 rounded-l-none"
          aria-label="수량 증가"
          onClick={() => setCount((n) => clamp(n + 1))}
        >
          <Plus size={13} />
        </Button>
      </div>

      {/* 목업 — 다음 차수에서 실제 배선 (생성 / 씬 생성 / 취소 3상태 + 실제 소모 추정) */}
      <Button variant="accent" size="lg" className="min-w-0 flex-1 gap-2">
        생성
        <span className="rounded-md bg-paper/20 px-1.5 py-0.5 font-mono text-[11.5px] opacity-90">
          −20
        </span>
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className={cn('h-10 w-11 shrink-0', historyOpen && 'bg-surface-2 text-ink')}
        title="히스토리"
        aria-label="히스토리"
        onClick={onToggleHistory}
      >
        <History size={16} />
      </Button>
    </div>
  )
}
