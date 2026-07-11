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
  bootstrap.ts     DB 초기화 → 생성 큐 → 핸들러 등록 → window.nais 주입 → 렌더러 마운트
  backend/
    ipc.ts         invoke 라우터 + 이벤트 버스 (src/main/ipc.ts의 웹 대응)
    db/index.ts    sql.js(WASM) 어댑터 — better-sqlite3 사용 표면을 흉내내 repo 재사용
    db/settings.ts 설정/토큰 저장 (safeStorage 없음 — 아래 한계 참조)
    pipeline.ts    생성 오케스트레이션 (src/main/index.ts 큐 콜백의 이식)
    images/storage.ts  IndexedDB 원본 + Canvas 썸네일 (web:// 논리 경로)
    image-utils.ts Canvas 기반 sharp 대체 (썸네일·리사이즈·마스크 정규화)
    idb.ts / assets.ts / png-text.ts
  shims/           fs/path/crypto/events/zlib/electron/sharp — 재사용 모듈용 최소 shim
  public/sw.js     서비스워커 — /nais-image/?path= 를 IndexedDB에서 서빙
                   (Electron nais-image:// 프로토콜의 웹 대응)
```

### 원작 코드 재사용 방식 (핵심 설계)

| 분류 | 모듈 | 방법 |
| --- | --- | --- |
| 그대로 재사용 | `nai/payload·stream·client·endpoints`, `fragments/processor`, `queue/generation-queue`, `shared/*` | 순수 TS — 직접 import (Buffer/events/crypto shim) |
| 재사용 + DB 리다이렉트 | `characters/fragments/prompts/scenes/refs/library repo`, `nai/anlas-log`, `tags`, `nai/tokenizer`, `db/migrations` | `vite.web.config.ts`가 `src/main/db` import를 `src/web/backend/db`(sql.js)로 리다이렉트 |
| 웹 대체 구현 | `db/index`, `db/settings`, `images/storage`, `ipc`, 생성 파이프라인 | Electron/fs/sharp 결합이 강해 별도 구현 (동작 규칙은 데스크톱과 동일하게 유지) |

원본 파일 수정은 두 곳뿐, 모두 가산적:
- `src/preload/index.ts` — `NaisApi`에 선택적 `imageUrl?` 추가 (Electron은 미제공)
- `src/renderer/src/lib/constants.ts` — `imageUrl()`이 플랫폼 제공 URL을 우선 사용

## 데이터 저장

| 항목 | 데스크톱 | 웹 |
| --- | --- | --- |
| DB (프리셋·히스토리·캐릭터 등) | `userData/nais3.db` | IndexedDB `nais3-web/kv` (sql.js export, 쓰기 후 400ms 디바운스 + 탭 숨김/닫기 시 flush) |
| 생성 이미지 원본 | `사진/NAIS3/...` 파일 | IndexedDB `files` (`web://images/...` 논리 경로) |
| 자동저장 OFF 원본 | 메모리 링버퍼(20장) | 동일 + 세션 시작 시 소멸 |
| NAI 토큰 | safeStorage(OS 키체인) | **base64 평문** — 데스크톱의 safeStorage 미지원 폴백과 동일. 브라우저 오리진 격리에 의존 |

## 1차 포팅 범위 (지원)

토큰 인증·잔액, t2i/i2i/인페인트 생성(스트리밍 미리보기 포함), 큐, 히스토리, 설정,
프롬프트 프리셋, 캐릭터 프롬프트, 조각(txt 가져오기/내보내기 포함), 씬 CRUD·생성,
디렉터 툴·업스케일, 태그 자동완성, 토큰 카운트, 메타데이터 읽기(tEXt·DB payload),
다른 이름으로 저장(다운로드)·클립보드 복사.

## 미지원 / 한계 (후속 예정)

- **바이브 트랜스퍼 / 캐릭터 레퍼런스**: 목록 표시만. 생성 파이프라인의 준비 단계(`refs/prepare`)가 sharp/fs 결합이라 후속 포팅.
- **라이브러리**: 목록만 (가져오기는 파일 다이얼로그·fs 의존 → picker 기반으로 후속).
- **백업 가져오기/내보내기**: 후속 (refs 파일 참조 포함 문제).
- **스텔스 메타데이터**(alpha-LSB)·zTXt: zlib/픽셀 접근 경로 미이식.
- **웹 검색 모드**: Electron `<webview>` 전용 — 웹에선 동작 안 함 (설정의 탭 숨김 토글로 숨길 수 있음).
- 타이틀바 창 버튼(최소화 등)은 no-op.
- **모바일 레이아웃**: 현재 데스크톱 레이아웃 그대로 (가상 뷰포트 + 핀치 줌). 반응형은 별도 마일스톤.
- 대용량 히스토리: DB 스냅샷 전체를 export하는 지속화 방식이라 수천 장 규모에선 쓰기 비용 증가 (wa-sqlite/OPFS 전환 검토).

## 배포

`out/web`은 순수 정적 파일 — GitHub Pages 등 아무 정적 호스팅에 올리면 된다.
**HTTPS 필수** (서비스워커·clipboard·crypto). LAN 실기기 테스트는
`npm run dev:web` 후 `http://<PC IP>:5173` — 단 http라 SW가 비활성화되어
저장 이미지 풀해상도 표시가 제한된다 (최근 생성분은 오브젝트 URL로 표시됨).
