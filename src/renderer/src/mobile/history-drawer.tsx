import { AnimatePresence, motion } from 'motion/react'
import { HistoryPanel } from '../components/history-panel'

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
          {/* 데스크톱 우측 패널 카드(자체 헤더·카운트·비우기 포함)를 그대로 슬라이드 인 —
              p-2로 카드가 데스크톱처럼 가장자리에서 떠 보인다 */}
          <motion.aside
            key="drawer"
            className="absolute inset-y-0 right-0 z-50 max-w-[75vw] p-2 drop-shadow-2xl"
            initial={{ x: '110%' }}
            animate={{ x: 0 }}
            exit={{ x: '110%' }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <HistoryPanel />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
