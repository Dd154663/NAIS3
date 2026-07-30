import { Settings } from 'lucide-react'
import { estimateAnlas } from '@shared/anlas'
import { cn } from '../lib/utils'
import { PAGES } from '../components/page-nav'
import { AnlasChips } from '../components/titlebar'
import { ThemeToggle } from '../components/theme-toggle'
import { useGenerationStore } from '../stores/generation-store'
import { useLayoutStore } from '../stores/layout-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'

/** 모바일 탭 타깃 최소치 (44×44) — 시각 크기는 규약대로, 히트 영역만 확장 */
const TAP = 'grid size-11 shrink-0 place-items-center rounded-md transition-colors'

/**
 * 상단 바 (전 모드 공통 고정). 좌측 Anlas 칩 + 테마 토글 / 중앙 모드 아이콘 내비 /
 * 우측 설정. 창 컨트롤(─□✕)은 웹·모바일에 없다.
 */
export function TopBar(): React.JSX.Element {
  const centerMode = useLayoutStore((s) => s.centerMode)
  const setCenterMode = useLayoutStore((s) => s.setCenterMode)
  const hiddenPages = useLayoutStore((s) => s.hiddenPages)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const visible = PAGES.filter((p) => p.id === 'main' || !hiddenPages.includes(p.id))

  // Anlas 잔액·예상 소모 — 데스크톱 타이틀바와 동일 계산 (실제 배선)
  const anlasBalance = useGenerationStore((s) => s.anlasBalance)
  const request = useGenerationStore((s) => s.request)
  const batchCount = useGenerationStore((s) => s.batchCount)
  const tier = useGenerationStore((s) => s.subscriptionTier)
  const enabledCrefs = useCharRefsStore((s) => s.items.filter((c) => c.enabled).length)
  const unencodedVibes = useVibesStore(
    (s) => s.items.filter((v) => v.enabled && !v.encodedReady).length
  )
  const anlasCost = estimateAnlas({
    width: request.width,
    height: request.height,
    steps: request.steps,
    strength: request.source ? (request.i2iStrength ?? 0.7) : 1,
    charRefCount: enabledCrefs,
    isOpus: tier === 'opus',
    batchCount,
    unencodedVibes
  }).total

  return (
    <header className="relative flex h-14 shrink-0 select-none items-center gap-1 bg-paper px-1">
      {/* 모드 내비 — 상단 바 중앙(데스크톱 타이틀바와 같은 절대 중앙 배치).
          아이콘·hiddenPages는 데스크톱 PageNav와 동일, 모바일은 아이콘 전용 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <nav className="pointer-events-auto flex items-center gap-0.5">
          {visible.map((page) => {
            const active = centerMode === page.id
            return (
              <button
                key={page.id}
                onClick={() => setCenterMode(page.id)}
                title={page.label}
                aria-label={page.label}
                className={cn(
                  TAP,
                  active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2'
                )}
              >
                <page.icon className="size-4" />
              </button>
            )
          })}
        </nav>
      </div>

      <AnlasChips balance={anlasBalance} cost={anlasCost} />
      <ThemeToggle />

      <div className="min-w-0 flex-1" />

      <button
        onClick={() => setSettingsOpen(true)}
        title="설정"
        aria-label="설정"
        className={cn(TAP, 'text-muted hover:bg-surface-2 hover:text-ink')}
      >
        <Settings size={16} />
      </button>
    </header>
  )
}
