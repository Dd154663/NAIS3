# NAIS3 셀프호스트 (개요)

예약 생성을 백그라운드에서 계속 돌리고 PC·폰이 같은 히스토리를 보게 하려면 개인용 서버가
필요합니다. NAIS3는 **로컬 모드**(설치 없이 브라우저에서 바로, 단 탭을 닫으면 생성 중단·기기별
데이터)와 **서버 모드**(내 서버가 예약을 대신 실행 — 백그라운드 보장, 클라우드 저장, 기기 간 공유)를
모두 지원합니다.

## 전체 가이드는 웹에서 (단일 진실 공급원)

상세한 셀프호스트 가이드는 웹 페이지 하나로 관리됩니다. 아래 링크에서 브라우저로 여세요:

- GitHub Pages(로컬 모드): <https://dd154663.github.io/NAIS3/self-host.html>
- 내 셀프호스트 서버: `https://<서버주소>/self-host.html`

두 가지 공식 호스팅 트랙(① PC + Tailscale, ② Oracle Always Free), 보안, 백업, 업데이트, 문제
해결이 모두 그 페이지에 있습니다. 이 마크다운은 포인터일 뿐이며 내용은 중복하지 않습니다.

## 빠른 시작 요약

준비물: Node.js 20+, git.

```bash
git clone https://github.com/dd154663/NAIS3.git
cd NAIS3
npm ci
npm run build:web
npm run build:server
NAIS3_ACCESS_KEY=여기에-긴-키 node dist-server/nais3-server.cjs
```

브라우저에서 첫 방문 시 키와 함께 접속합니다 (키는 브라우저에 저장되어 다음부터는 주소만으로 열림):

```
http://127.0.0.1:8787/?serverKey=여기에-긴-키
```

폰 접속·상시 서버·보안·백업은 위 웹 가이드를 참고하세요.
