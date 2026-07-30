import { History } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'

const EASE = [0.22, 1, 0.36, 1] as const

/**
 * 히스토리 우측 드로어 (상주하지 않는 오버레이 — 가장자리 주인 규칙).
 * 부모(셸의 상단 바 아래~생성 바 위 컨테이너) 안에 absolute로 갇혀 생성 바를 덮지 않는다.
 * 딤 탭 또는 생성 바 히스토리 버튼 재탭으로 닫힘.
 */
export function HistoryDrawer({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="dim"
            className="absolute inset-0 z-50 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            className="absolute inset-y-0 right-0 z-50 flex w-[240px] max-w-[75vw] flex-col border-l border-line bg-surface shadow-2xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
              <History size={14} className="text-muted" />
              <span className="text-[13px] font-medium">히스토리</span>
            </div>
            {/* 목업 — 다음 차수에서 실제 배선 (HistoryPanel 재사용) */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="grid grid-cols-2 gap-2">
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="aspect-square rounded-md bg-surface-2" />
                ))}
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
