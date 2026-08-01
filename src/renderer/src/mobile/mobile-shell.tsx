import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { DirectorMode } from '../components/director-mode'
import { LibraryMode } from '../components/library-mode'
import { PreviewPane } from '../components/preview-pane'
import { SceneMode } from '../components/scene-mode'
import { WebSearchMode } from '../components/web-search-mode'
import { useLayoutStore } from '../stores/layout-store'
import { cn } from '../lib/utils'
import { GenBar } from './gen-bar'
import { HistoryDrawer } from './history-drawer'
import { PromptSheet, type SheetSnap } from './prompt-sheet'
import { TopBar } from './top-bar'

/**
 * 모바일 셸 — 세로 플렉스: 상단 바 / 중앙 콘텐츠 / (메인·씬 모드) 프롬프트 시트 / 생성 바.
 *
 * 중앙 콘텐츠는 데스크톱 App.tsx와 같은 centerMode 스위치를 그대로 쓴다. 하단 바는 모드가
 * 소유 — 메인·씬 = 생성 바 + 프롬프트 시트, 디렉터·라이브러리·웹 = 콘텐츠만.
 */
export function MobileShell(): React.JSX.Element {
  const centerMode = useLayoutStore((s) => s.centerMode)
  const [snap, setSnap] = useState<SheetSnap>('closed')
  const [historyOpen, setHistoryOpen] = useState(false)
  // 하단 세트(프롬프트 시트 + 생성 바)를 가지는 모드 — 데스크톱 App.tsx가 씬 모드에서도
  // 좌측 프롬프트 패널(생성 행 포함)을 그대로 유지하는 것과 동형. 시트의 프롬프트는
  // 베이스 프롬프트라 씬 생성 결과(베이스+씬 결합)에 실제로 쓰이고, 생성 버튼은
  // GenerateRow의 '씬 생성 (n장)' 상태로 알아서 바뀐다 (SPEC.md 씬 모드 합의)
  const hasGenDock = centerMode === 'main' || centerMode === 'scene'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar />

      {/* 드로어 위치 기준 컨테이너 — 상단 바 아래 ~ 생성 바 위. 생성 바는 이 밖이라
          드로어·딤이 절대 덮지 못하고(항상 최상단), 히스토리 버튼 재탭 닫힘이 성립한다 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* 중앙 콘텐츠 — 시트가 full까지 열리면 높이가 0으로 줄어들므로 넘침을 잘라 주고,
            하단 패딩도 제거해 시트가 상단 바에 정확히 닿게 한다 */}
        <div
          className={cn(
            'relative flex min-h-0 flex-1 flex-col overflow-hidden px-2',
            hasGenDock && snap === 'full' ? 'pb-0' : 'pb-2'
          )}
        >
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
            {hasGenDock && snap !== 'closed' && (
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

        {hasGenDock && <PromptSheet snap={snap} onSnapChange={setSnap} />}

        <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
      </div>

      {hasGenDock && (
        <GenBar historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen((v) => !v)} />
      )}
    </div>
  )
}
