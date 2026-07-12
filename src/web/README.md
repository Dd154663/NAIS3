# NAIS3 웹 (모바일/PWA) 빌드

Electron 데스크톱 앱을 **코드 수정 없이** 브라우저에서 구동하는 포팅 레이어입니다.
iOS(Safari "홈 화면에 추가")·Android 모두 PWA로 설치할 수 있습니다 — 앱스토어 불필요.

```bash
npm run dev:web       # 개발 서버 (http://localhost:5173, --host로 LAN 노출)
npm run build:web     # 타입체크 + 프로덕션 빌드 → out/web (정적 호스팅용)
npm run preview:web   # 빌드 결과 미리보기
```

## 왜 가능한가

- 렌더러는 Electron/Node를 직접 import하지 않고, 유일한 접점이 `window.nais.{invoke,on}` 계약(`src/shared/types.ts`)이다.
- **NovelAI API는 CORS를 허용한다** (`image.novelai.net`: `Access-Control-Allow-Origin: *`, `api.novelai.net`: origin echo — 2026-07 확인). 즉 브라우저에서 직접 호출 가능, 프록시 불필요.
- 스트리밍 미리보기(`nai/stream.ts`)는 fetch `ReadableStream` 기반이라 브라우저에서 그대로 동작한다.

## 아키텍처

```
src/web/
  main.ts          진입점 — Buffer 폴리필 후 부트스트랩 동적 import
  bootstrap.ts     워커 부팅(ready 대기) → 메인 핸들러 → window.nais 주입 → SW → 렌더러
  bus.ts / rpc.ts  채널 핸들러·이벤트 레지스트리 + 메인↔워커 RPC 메시지 타입
  channel-coverage.ts  채널→처리 위치 선언표 (유지보수 가드레일 — 아래 "유지보수 계약")
  main-handlers.ts DOM 결합 채널만 (picker/다운로드/클립보드/알림/창 no-op)
  worker/          Electron main 프로세스 대응 — DB·생성 큐·NAI 호출 전부 여기서
    index.ts       Buffer 폴리필 → boot 동적 import (부팅 단계 계측 포함)
    boot.ts        DB 초기화 → 큐 → 핸들러 등록 → ready
    handlers.ts    워커 채널 핸들러 (src/main/ipc.ts의 웹 대응)
  backend/
    ipc.ts         메인 invoke 라우터 (로컬 핸들러 or 워커 RPC) + 이벤트 브릿지
    db/index.ts    공식 SQLite WASM(opfs-sahpool) 어댑터 — better-sqlite3 사용 표면을
                   흉내내 repo 재사용. OPFS라 페이지 단위 쓰기 (쓰기 증폭 없음)
    db/settings.ts 설정/토큰 저장 (safeStorage 없음 — 아래 한계 참조)
    pipeline.ts    생성 오케스트레이션 (src/main/index.ts 큐 콜백의 이식)
    images/storage.ts  IndexedDB 원본 + Canvas 썸네일 (web:// 논리 경로)
    image-utils.ts Canvas/OffscreenCanvas 기반 sharp 대체 (썸네일·리사이즈·마스크 정규화)
    dom-io.ts      파일 picker/다운로드 (메인 전용)
    idb.ts / assets.ts / png-text.ts
  shims/           fs/path/crypto/events/zlib/electron/sharp — 재사용 모듈용 최소 shim
  tools/           drift-check.mjs + drift-sentinel.json (유지보수 가드레일)
  public/sw.js     서비스워커 — /nais-image/?path= 를 IndexedDB에서 서빙
                   (Electron nais-image:// 프로토콜의 웹 대응) + 앱 셸 프리캐시
```

### 원작 코드 재사용 방식 (핵심 설계)

| 분류 | 모듈 | 방법 |
| --- | --- | --- |
| 그대로 재사용 | `nai/payload·stream·client·endpoints`, `fragments/processor`, `queue/generation-queue`, `shared/*` | 순수 TS — 직접 import (Buffer/events/crypto shim) |
| 재사용 + DB 리다이렉트 | `characters/fragments/prompts/scenes/refs/library repo`, `nai/anlas-log`, `tags`, `nai/tokenizer`, `db/migrations` | `vite.web.config.ts`가 `src/main/db` import를 `src/web/backend/db`(SQLite WASM)로 리다이렉트 |
| 웹 대체 구현 | `db/index`, `db/settings`, `images/storage`, `ipc`, 생성 파이프라인 | Electron/fs/sharp 결합이 강해 별도 구현 (동작 규칙은 데스크톱과 동일하게 유지) |

원본 파일 수정은 두 곳뿐, 모두 가산적:
- `src/preload/index.ts` — `NaisApi`에 선택적 `imageUrl?` 추가 (Electron은 미제공)
- `src/renderer/src/lib/constants.ts` — `imageUrl()`이 플랫폼 제공 URL을 우선 사용

## 유지보수 계약 — 원작 개발 시 웹 포트를 신경 써야 하는 범위

**대부분의 수정은 웹 포트에 자동 반영됩니다.** 렌더러(UI 전체), `src/shared`,
그리고 `src/main`의 repo·NAI 클라이언트·마이그레이션·큐 등 재사용 모듈은 웹이 그대로
import하므로 아무것도 할 필요가 없습니다. DB 스키마 변경(`db/migrations.ts`)도 자동입니다.

웹 쪽 대응이 필요한 경우는 아래 두 가지뿐이고, **둘 다 CI(`web-check.yml`)가 자동으로 알려줍니다**:

| 수정 대상 | 감지 방법 | 대응 |
| --- | --- | --- |
| `shared/types.ts`에 IPC 채널 추가/삭제 | `typecheck:webapp`이 `src/web/channel-coverage.ts`에서 채널명을 지목하며 실패 | 워커(`worker/handlers.ts`) 또는 메인(`main-handlers.ts`)에 핸들러 구현 + 표에 한 줄 추가 |
| Electron 결합 글루 파일 수정 (`src/main`의 ipc·index·images/storage·db/settings·db/index·refs/prepare·backup/repo) | `check:web-drift`가 바뀐 파일과 검토할 웹 파일을 출력하며 실패 | 웹 대응 파일에 반영 여부 검토 → `npm run check:web-drift:update`로 해시 갱신 후 함께 커밋 |

웹 포트를 직접 고치기 어려우면 CI 출력을 그대로 이슈로 남겨주세요 — 웹 포트 쪽에서 대응합니다.
CI 빨간불은 데스크톱 릴리스를 막는 게이트가 아니라 "웹 대응 필요" 신호입니다.

주의: `vite.web.config.ts`에 플러그인을 추가할 때는 `worker.plugins`에도 필요한지 검토
(Vite 워커 빌드는 별도 롤업 빌드라 `config.plugins`가 적용되지 않음 — 실제 사고 사례 있음).

## 데이터 저장

| 항목 | 데스크톱 | 웹 |
| --- | --- | --- |
| DB (프리셋·히스토리·캐릭터 등) | `userData/nais3.db` | OPFS `nais3.db` (공식 SQLite WASM, opfs-sahpool — 트랜잭션 단위 내구성. 구버전 IndexedDB 저장분은 첫 부팅 시 자동 이식) |
| 생성 이미지 원본 | `사진/NAIS3/...` 파일 | IndexedDB `files` (`web://images/...` 논리 경로) |
| 자동저장 OFF 원본 | 메모리 링버퍼(20장) | 동일 + 세션 시작 시 소멸 |
| NAI 토큰 | safeStorage(OS 키체인) | **base64 평문** — 데스크톱의 safeStorage 미지원 폴백과 동일. 브라우저 오리진 격리에 의존 |

## 지원 범위 — 데스크톱 기능 파리티

토큰 인증·잔액, t2i/i2i/인페인트 생성(스트리밍 미리보기), **바이브 트랜스퍼·캐릭터 레퍼런스**
(인코딩 캐시 포함), 큐, 히스토리, 설정, 프롬프트 프리셋, 캐릭터, 조각(txt IO), 씬(CRUD·생성·
JSON/ZIP 내보내기·가져오기), **라이브러리**(가져오기·스택), 디렉터 툴·업스케일, 태그 자동완성,
토큰 카운트, **메타데이터 완전판**(tEXt·zTXt/iTXt·스텔스 alpha-LSB·DB payload),
**백업**(NAIS3 왕복 + NAIS2 가져오기, 데스크톱 백업과 상호 호환), 다른 이름으로 저장(다운로드)·
클립보드 복사, 앱 셸 오프라인 캐시(프로덕션 빌드), 새 배포 감지 → 업데이트 알림(reload).

파일 다이얼로그는 브라우저 picker로, 파일 저장은 다운로드로 대체된다.

## 웹에서 개념이 다른 것 (의도된 차이)

- **웹 검색 모드**: Electron `<webview>` 전용 (브라우저는 대상 사이트가 iframe을 차단) —
  웹에선 탭 기본 숨김 (설정 > 표시할 탭에서 다시 켤 수 있음).
- **폴더 열기 / 탐색기 표시 / 창 버튼**: 파일 시스템·창 개념 부재 — no-op.
- **자동 업데이트**: PWA는 재접속 시 자동 갱신. 새 배포가 감지되면 기존 업데이트 UI로 알리고
  "재시작"은 reload로 동작.
- **토큰 저장**: OS 키체인이 없어 base64 저장 (데스크톱의 safeStorage 미지원 폴백과 동일).
  브라우저 오리진 격리에 의존.
- 이미지 삭제 시 웹은 "기록만 삭제"여도 blob을 지운다 (접근 불가능한 고아 blob 방지).

## 남은 한계

- **모바일 레이아웃**: 데스크톱 레이아웃 그대로 (가상 뷰포트 + 핀치 줌). 반응형은 별도 마일스톤.
- 수십GB 원본 이미지는 브라우저 저장소에 갇힘 — 외부 스토리지(Google Drive) 연동 진행 중.
- iOS는 Safari 16.4+ 필요 (OffscreenCanvas 2D·OPFS sahpool). DB 특성상 다중 탭 동시 접근 불가.
- tags.json(16MB)은 오프라인 캐시에서 제외 — 태그 자동완성 첫 사용 시 네트워크 필요.
- 브라우저 사이트 데이터 삭제 = 전체 데이터 삭제 (`navigator.storage.persist()`로 자동 회수는
  방지 요청, 백업 내보내기로 대비 권장).

## 배포

`out/web`은 순수 정적 파일 — GitHub Pages 등 아무 정적 호스팅에 올리면 된다.
**HTTPS 필수** (서비스워커·clipboard·crypto). LAN 실기기 테스트는
`npm run dev:web` 후 `http://<PC IP>:5173` — 단 http라 SW가 비활성화되어
저장 이미지 풀해상도 표시가 제한된다 (최근 생성분은 오브젝트 URL로 표시됨).
