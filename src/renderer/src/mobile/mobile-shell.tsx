import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { DirectorMode } from '../components/director-mode'
import { LibraryMode } from '../components/library-mode'
import { PreviewPane } from '../components/preview-pane'
import { SceneMode } from '../components/scene-mode'
import { WebSearchMode } from '../components/web-search-mode'
import { useLayoutStore } from '../stores/layout-store'
import { GenBar } from './gen-bar'
import { HistoryDrawer } from './history-drawer'
import { PromptSheet, type SheetSnap } from './prompt-sheet'
import { TopBar } from './top-bar'

/**
 * 모바일 셸 — 세로 플렉스: 상단 바 / 중앙 콘텐츠 / (메인 모드) 프롬프트 시트 / 생성 바.
 *
 * 중앙 콘텐츠는 데스크톱 App.tsx와 같은 centerMode 스위치를 그대로 쓴다 (모드 내부의
 * 모바일 적응은 다음 차수). 하단 바는 모드가 소유 — 메인 = 생성 바, 그 외 모드의 하단 바
 * 구성은 다음 차수 합의 대상이라 콘텐츠만 표시한다.
 */
export function MobileShell(): React.JSX.Element {
  const centerMode = useLayoutStore((s) => s.centerMode)
  const [snap, setSnap] = useState<SheetSnap>('closed')
  const [historyOpen, setHistoryOpen] = useState(false)
  const isMain = centerMode === 'main'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar />

      {/* 중앙 콘텐츠 — 시트가 full까지 열리면 높이가 0에 가까워지므로 넘침을 잘라 준다 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2">
        {centerMode === 'scene' ? (
          <SceneMode />
        ) : centerMode === 'director' ? (
          <DirectorMode />
        ) : centerMode === 'library' ? (
          <LibraryMode />
        ) : centerMode === 'websearch' ? (
          <WebSearchMode />
        ) : (
          <PreviewPane />
        )}
        {/* 시트 밖(중앙 콘텐츠) 딤 — 탭하면 시트 닫힘. 드로어(z-50)보다 아래 */}
        <AnimatePresence>
          {isMain && snap !== 'closed' && (
            <motion.div
              key="sheet-dim"
              className="absolute inset-0 z-40 bg-black/50 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => setSnap('closed')}
            />
          )}
        </AnimatePresence>
      </div>

      {isMain && (
        <>
          <PromptSheet snap={snap} onSnapChange={setSnap} />
          <GenBar historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen((v) => !v)} />
        </>
      )}

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  )
}
