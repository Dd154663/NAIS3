# Capacitor × Android 10~16 (API 29~36) 조사 (2026-08-01)

Capacitor APK 포팅(M-P5 예정분)을 위한 사실관계 정리. 두 축의 결합:
저장소 전수조사(웹 포트 IO·저장소·플랫폼 API — 별도 조사분) + 외부 검증(공식 문서·
소스 원문, 출처·확신도 명시). 결정은 하지 않았고, 말미에 선택지만 나열한다.

범례: 확신도 = **확실**(1차 출처 원문) / **추정**(2차·정황) / **검증 불가**

## 0. 최상위 결론 4가지

1. **Capacitor 8이 현재 안정판**(8.5.0, minSdk 24·targetSdk 36). 7은 7.6.8에서
   유지보수 단계. 버전 선택이 minSdk·edge-to-edge 대응을 통째로 결정한다.
2. **OPFS `FileSystemSyncAccessHandle`은 Android(Chrome·WebView 공통) 109부터**
   (2023-01, MDN BCD + Chrome 109 릴리스 노트 + blink-dev 3중 확인 — 확실).
   데스크톱 크롬(102/108)과 다르다. 이전 계획서의 "WebView 108+" 표기는 **109로 정정**.
   minSdk가 아니라 **WebView 버전이 진짜 하한선**이다.
3. **Android WebView는 SharedArrayBuffer 미지원**(BCD `false` — 확실) +
   Capacitor는 COOP/COEP 헤더 설정 불가(이슈 #7813 closed as not planned — 확실)
   → sqlite-wasm 기본 `opfs` VFS는 원천 불가, **`opfs-sahpool`이 유일 경로.**
   **우리 앱은 이미 sahpool을 쓰고 있으므로 이 지뢰는 이미 피해 있다.**
4. **Capacitor 7.0+는 `resolveServiceWorkerRequests: true`가 기본** — SW의 fetch가
   `ServiceWorkerClient.shouldInterceptRequest`로 Capacitor 로컬 서버에 위임된다
   (Bridge.java 원문 — 확실). SW 이미지 서빙(`/nais-image/`)이 공식 지원 경로에 있음.
   단 실기기 스모크는 필요(코드 경로만 확인).

## 1. Capacitor 버전 요구사항 (확실 — 공식 저장소 원문)

| 항목 | Capacitor 7 (7.6.8) | Capacitor 8 (8.5.0) |
|---|---|---|
| minSdk / target / compile | 23 / 35 / 35 | 24 / 36 / 36 |
| JDK · AGP · Gradle | 21 · 8.7.2 · 8.11.1 | Studio 자동 · 8.13.0 · 8.14.3 |
| Android Studio | Ladybug 2024.2.1+ | Otter 2025.2.1+ |
| Node | — | 22+ |
| edge-to-edge | `adjustMarginsForEdgeToEdge`(기본 disable) | 내장 SystemBars, 강제 |

- targetSdk 임의 조합 비지원("does not support custom target SDK versions").
- `androidScheme` 기본 `https` + `hostname` 기본 `localhost` → 오리진
  `https://localhost` = secure context (OPFS·SW·clipboard 충족). **hostname 변경 금지.**
- WebView 하한: 하드 55(Bridge.java) / 설정 `minWebViewVersion` 기본 60, 미달 시
  Logcat 에러 + `server.errorPath`로 리다이렉트 가능 → **OPFS 게이트로 쓸 수 있는 카드**
  (`minWebViewVersion: 109` + 안내 페이지).
- Capacitor 8 파괴적 변경: `adjustMarginsForEdgeToEdge` 제거, manifest
  `configChanges`에 `density` 추가 필요, 레이아웃 파일명 변경.

## 2. 버전별 WebView 사정

- Android 10~16은 전부 **Trichrome** 구조(`com.google.android.webview` + 공유
  라이브러리)로 동일 — 구간 내 구조 차이 없음(확실). 차이는 출고 버전·업데이트 여부뿐.
- WebView 고착 시나리오(확실): 비GMS/AOSP 기기(프리빌트, 정기 업데이트 없음 명시),
  중국 내수·커스텀 ROM, Play 미사용/저장공간 부족, **에뮬레이터**(자동 업데이트 안 됨
  — Capacitor 문서 명시).
- 출고 WebView 정확 버전표는 **검증 불가**. 확실한 것: Android 10(2019)~13(2022)은
  전부 109(2023-01) 이전 출시 → **출고 상태로는 OPFS 불가, Play 업데이트가 전제**.
  Android 14(2023-10)+는 출고 시점부터 109 이후.

## 3. 저장·권한 지도 (API 29~36)

**Capacitor Filesystem에 `Directory.Downloads`는 없다**(README 원문 — 확실).
enum: Documents/Data/Library/Cache/External/ExternalStorage/ExternalCache/
LibraryNoCloud/Temporary. 플러그인·코어의 manifest는 비어 있음 → 권한은 전부 앱 선언.

| 경로 | API 29 | 30~32 | 33~36 |
|---|---|---|---|
| 앱 내부(Data/Cache/…) · 앱 전용 외부(External) | 권한 0 | 권한 0 | 권한 0 |
| `Documents`(공용) | WRITE + `requestLegacyExternalStorage` | 앱 소유 파일만(격리) | 동일 |
| `ExternalStorage`(공용 루트) | 제한적 | **사용 불가** | **사용 불가** |
| **MediaStore 기여**(Downloads/Pictures에 자기 파일) | **권한 0** | 권한 0 | 권한 0 |
| **SAF**(`ACTION_CREATE_DOCUMENT`) / **Share 시트** | 권한 0 | 권한 0 | 권한 0 |

- Android 공식 원문: "Android 10+에서는 자기 앱 소유 미디어(MediaStore.Downloads
  포함)에 저장소 권한 불필요"(확실). API 33+의 `READ_MEDIA_*`는 **남의 미디어를 읽을
  때만** 필요 — 우리 흐름(자기 파일 쓰기 + 피커 가져오기)에는 불필요.
- `MANAGE_EXTERNAL_STORAGE`는 파일 매니저류 전용 — 쓰지 말 것(공식 가이드).
- "다운로드처럼 저장" 권장 순위(추정 — 공식 원칙 + 평판 플러그인 기반):
  ① Share 시트(Cache에 쓰고 `@capacitor/share`) — 권한 0·코어만
  ② SAF 저장 다이얼로그 — 권한 0·서드파티 플러그인 필요
  ③ MediaStore Downloads 직접 기여(`capacitor-filesharer` 등 서드파티) — 권한 0(29+)
  ④ Directory.External(앱 전용) ⑤ Documents(11+에서 무의미, 비권장)
- `<a download>` 미동작 원인: WebView에 DownloadListener 미등록(추정) —
  기존 판단(다운로드 8채널 무음 실패) 유지, dom-io.ts `downloadBytes()` 교체가 정답.

**가져오기**: Capacitor가 `onShowFileChooser`를 구현(BridgeWebChromeClient.java 원문
— 확실). accept/multiple 정상, **저장소 권한 0**. manifest에 CAMERA를 안 넣으면
카메라 권한 프롬프트도 없음. `accept="image/*"`면 기기에 따라 시스템이 photo picker로
리다이렉트(Play services 백포트, 4.4~12까지 소급). → 우리 `pickFiles()`·디렉터 전용
input 모두 무수정 동작 예상 (실기기 확인만).

## 4. UI 계열: edge-to-edge · 다크모드 · 백 제스처

**Android 15(API 35), targetSdk 35 — edge-to-edge 강제(확실)**: WebView가 시스템 바
뒤로 그려짐, `setStatusBarColor` 등 비활성. 컷아웃 `ALWAYS` 강제.
**CSS `env(safe-area-inset-*)`는 WebView 140 미만에서 신뢰 불가**(safe-area 플러그인
README — 추정): `@capacitor-community/safe-area`가 Chromium<140이면 padding 직접
주입으로 우회. 이 앱의 safe-area 사용처(생성 바 pb, 설정 top 오프셋, Drive 칩)는
이 값에 의존하므로 **플러그인 채택이 사실상 필수** 후보.

**Android 16(API 36), targetSdk 36 — opt-out 제거(확실)**: edge-to-edge 협상 불가.
**predictive back 기본 ON** — `onBackPressed`/`KEYCODE_BACK` 미전달.
Capacitor 8은 androidx.activity 1.11.0(OnBackPressedDispatcher 지원) — 정황상
안전하나 `@capacitor/app` backButton 실측 필요(추정). sw600dp+ 화면에서 방향 고정
무시(태블릿·폴더블).

**다크모드(Android 10+ 공통, 확실)**: WebView의 `prefers-color-scheme`는 시스템
설정이 아니라 **앱 테마의 `isLightTheme`가 결정**한다. Capacitor 기본 테마는 미지정
→ 영구 `light` 고정. 회피: `values`/`values-night` 리소스에서 `isLightTheme`
true/false 분기(+ `forceDarkAllowed=false`) — 네이티브 코드 0, 리소스만(레시피 자체는
추정, 실측 권장). 우리 앱의 테마 '시스템' 옵션이 이걸 전제로 한다.

**알림(확실)**: Web Notification API는 WebView에 없음(BCD `false`) — 현재
`notify:done`은 APK에서 영원히 무음. 쓰려면 `@capacitor/local-notifications` +
Android 13+에서 `POST_NOTIFICATIONS` 런타임 요청. 12L 이하는 자동 부여.

## 5. 네트워크·인증

- **Google OAuth**: WebView(`android.webkit.WebView`) 차단 정책(disallowed_useragent)
  현행 유효(Google 공식 블로그 — 확실). 우회 표준 = `@capacitor/browser`(Custom
  Tabs) + 커스텀 스킴 딥링크 + PKCE. 기존 방침(CLIENT_ID 미주입 → Drive 숨김)과 양립.
- **cleartext `ws://`**(서버 모드, PR② 영역): Android 9+ 기본 차단(확실, ws 적용은
  추정). 해법 = `network_security_config.xml` 직접 작성(우선순위가 manifest 속성보다
  높음). debug 전용 완화는 `src/debug/res/xml/` build variant 분리로.
  `server.cleartext` 옵션의 안드로이드 구현은 검증 불가 — 의존하지 말 것.
- **16KB 페이지 / targetSdk 정책**: 네이티브 `.so` 없으면 16KB 무관(확실; Capacitor
  코어·주요 플러그인 순수 Java/Kotlin — 추정, APK Analyzer 1회로 확정 가능).
  sqlite-wasm은 WASM이라 무관. Play의 targetSdk 요구는 **스토어 정책** — 사이드로드
  무관. OS 설치 차단은 Android 14=minTarget 23 / 15=24 하한뿐(확실), 우리는 무관.

## 6. Android 10~16 버전별 실질 영향 한 줄 요약

| Android | API | 이 앱에 걸리는 것 |
|---|---|---|
| 10 | 29 | 출고 WebView로는 OPFS 불가(Play 업데이트 전제) · isLightTheme 다크모드 고정 · ws:// 차단 |
| 11 | 30 | 위와 동일 + scoped storage 완전 시행(공용 경로 대신 MediaStore/SAF/Share) |
| 12/12L | 31/32 | 위와 동일 + `SCHEDULE_EXACT_ALARM`(정확 알림 쓸 때만) |
| 13 | 33 | 출고 WebView 여전히 <109 · `POST_NOTIFICATIONS` 런타임 필요 · photo picker 리다이렉트 |
| 14 | 34 | **출고부터 OPFS 가능** · 큰 신규 제약 없음 |
| 15 | 35 | edge-to-edge 강제 · env(safe-area)가 WebView<140에서 신뢰 불가 → 대응 필수 |
| 16 | 36 | opt-out 제거 · predictive back 기본 ON(백버튼 실측) · sw600dp+ 방향 고정 무시 |

공통: 가져오기 권한 0 / Web Notification 없음 / SAB 없음(sahpool 강제 — 이미 충족) /
Google 로그인 WebView 차단 / WebView 버전은 OS와 독립.

## 7. 결정 필요 항목 (선택지 — 합의 대상)

- **A. Capacitor 메이저**: 8(현행 안정, e2e 강제) vs 7(유지보수 단계, e2e 부분 제어)
- **B. minSdk**: 23/24(가능 하한) vs **29**(과제 범위 일치, 레거시 분기 제거) vs 30
- **C. OPFS 게이트**(B와 독립): `minWebViewVersion:109`+errorPath / 런타임 감지 배너 /
  폴백 VFS(고비용) / 없음(비권장) — 조합 가능
- **D. VFS**: 선택지 없음(sahpool 강제·이미 사용 중). 단일 연결 제약 정리 로직만 확인
- **E. 내보내기 방식**: Share 시트 / SAF / MediaStore / 종류별 매핑(이미지→MediaStore,
  백업 ZIP→SAF, JSON→Share 등) — dom-io.ts `downloadBytes()` 한 곳에 꽂힌다
- **F. safe-area**: `@capacitor-community/safe-area` / Cap8 내장 SystemBars만 /
  자체 insets 주입(네이티브 소량)
- **G. 다크모드**: values-night `isLightTheme` 분기(리소스만) / 수동 토글만 /
  MainActivity 소량 수정
- **H. predictive back**: 실측 후 결정(opt-out 폴백 가능)
- **I. ws:// (서버 모드)**: debug variant 한정 완화 권장 — PR② 시점 재론
- **J. Google 로그인**: 현행 방침(미주입 숨김) 유지, Custom Tabs 도입은 추후 옵션

## 8. 검증 불가 → 실측으로 넘긴 것

출고 WebView 정확 버전표 / WebView 전용 OPFS 버그 유무 / `server.cleartext` 구현 /
Android 16 설치 하한 / backButton@16 / SW 서빙 실기기 / 플러그인 `.so` 부재 /
values-night 다크모드 레시피. **우선 실측 3건**: ① 구형 기기 OPFS+WebView 버전
② SW 이미지 서빙 스모크 ③ Android 16 백버튼.

## 출처 (핵심만)

Capacitor 공식 저장소·문서 원문(variables.gradle, declarations.ts, Bridge.java,
BridgeWebChromeClient.java, 7-0/8-0 업그레이드 문서, setting-target-sdk), MDN
browser-compat-data 원문(FileSystemSyncAccessHandle·SharedArrayBuffer·Notification),
Chrome 109 릴리스 노트·blink-dev Intent to Ship, Android developer 공식 문서
(behavior-changes 14/15/16, data-storage/shared/media, security-config, dark-theme,
page-sizes), @capacitor/filesystem·local-notifications·browser README,
@capacitor-community/safe-area README, Google Developers Blog(OAuth WebView 차단),
ionic-team/capacitor 이슈 #7813 등.
