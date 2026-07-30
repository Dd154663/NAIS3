# NAIS3 작업 메모리 (개인 — mobile-port에만 커밋)

## 비-코드 커밋 규약 (2026-07-30 확정)

- 개인 작업물·논의·메모리 등 **명확히 코드가 아닌 것**은 반드시 **개별 커밋**으로
  분리한다 — 코드 수정과 같은 커밋에 섞여 오염되는 것 방지. 커밋 제목은 `기록:` 접두.
- 이런 비-코드 커밋은 기록 시마다 **MEMORY-INDEX.md**(중앙 인덱스)에 커밋 ID를
  등록해 나중에 빠르게 찾을 수 있게 한다 (내용 커밋 직후 인덱스 등록 커밋 1개 —
  ID는 커밋 후에 확정되므로 2단계가 정확하다).
- 이 커밋들은 **mobile-port에만** 올린다. PR은 feat/* 브랜치에서만 나가므로
  원본 PR에 섞일 일이 없다. feat/* 브랜치에서는 `.git/info/exclude`가 이 파일들을
  가려 add -A에 딸려 들어가지 않는다.

## 모바일 개발·테스트 루틴 (2026-07-30 확정)

1. **모바일 개발은 `feat/web-mobile` 브랜치에서.** (PR① 브랜치 — upstream/main 기반,
   서버 코드 없음. 코드 작업은 항상 여기서, mobile-port 직접 수정 금지)
2. **모바일 UI·실기기 테스트는 `mobile-port`로 푸시 후 테스트.**
   feat/web-mobile → mobile-port로 **merge만**(역방향 금지) → 푸시하면 Pages 자동 배포
   → https://dd154663.github.io/NAIS3/ 를 폰에서 확인. 배포 확인은 index-*.js 번들
   해시 변화 폴링. 병합 충돌 시 경계 파일(bootstrap/ipc/드리프트/CI/package.json)은
   서버 포함판(ours) 유지, 모바일 신규분은 feat 채택.
3. **2번 루틴은 안드로이드 실 포팅·패키징(Capacitor APK) 전까지 유효.**
   다만 그 이후에도 간단한 UI 점검은 PWA(Pages)가 피드백이 빠르므로 계속 유효.

## 브랜치 지도

| 브랜치 | 역할 |
|---|---|
| `feat/web-mobile` | PR① 개발 원천 (모바일 커밋은 전부 여기 먼저) |
| `mobile-port` | 통합·Pages 배포 (merge 전용 + 개인 오버레이) |
| `mobile-port-6rsgm0` | 동결 (P0 리팩터까지, 참조용) |
| `main` | upstream 미러 (v1.0.16 = e652ea7) |

## 주의 (재발 방지)

- `git add -A` 전에 빌드 산출물(dist-server/ 등) 확인 — feat 브랜치 .gitignore는
  upstream과 동일해 개인·산출물 파일이 걸러지지 않는다. `.git/info/exclude`에
  dist-server/·MEMORY.md·memory/·plans/ 등록해 둘 것 (컨테이너 재생성 시 다시).
- 모바일 UI는 SPEC.md(src/renderer/src/mobile/) 이식 원칙 3조가 최상위 규약 —
  구조 동형·원본 대조 의무·원본 가이드라인 엄수. UI 배치 변경은 사전 협의.
- Fable 쿼터 절약: 규모 있는 구현은 Opus 서브에이전트 위임, 검수·커밋은 직접.
