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
- 대용량 히스토리: DB 스냅샷 전체를 export하는 지속화 방식이라 수천 장 규모에선 쓰기 비용 증가
  (wa-sqlite/OPFS 전환 검토).
- tags.json(16MB)은 오프라인 캐시에서 제외 — 태그 자동완성 첫 사용 시 네트워크 필요.
- 브라우저 사이트 데이터 삭제 = 전체 데이터 삭제 (`navigator.storage.persist()`로 자동 회수는
  방지 요청, 백업 내보내기로 대비 권장).

## 배포

`out/web`은 순수 정적 파일 — GitHub Pages 등 아무 정적 호스팅에 올리면 된다.
**HTTPS 필수** (서비스워커·clipboard·crypto). LAN 실기기 테스트는
`npm run dev:web` 후 `http://<PC IP>:5173` — 단 http라 SW가 비활성화되어
저장 이미지 풀해상도 표시가 제한된다 (최근 생성분은 오브젝트 URL로 표시됨).
