import { History } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from '../components/ui/button'
import { GenerateRow } from '../components/prompt-panel'

/**
 * 하단 고정 생성 바 (메인 모드 소유) — 데스크톱 GenerateRow(prompt-panel.tsx)를
 * 그대로 재사용하고 히스토리 드로어 버튼만 trailing으로 덧붙인다.
 * 파라미터·수량·생성(3상태)·Anlas 계산 전부 데스크톱과 로직 공유(중복 0).
 */
export function GenBar({
  historyOpen,
  onToggleHistory
}: {
  historyOpen: boolean
  onToggleHistory: () => void
}): React.JSX.Element {
  return (
    <div
      className="shrink-0 border-t border-line bg-paper px-2 pt-2"
      style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
    >
      <GenerateRow
        trailing={
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
        }
      />
    </div>
  )
}
