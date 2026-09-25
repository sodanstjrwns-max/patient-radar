# Patient Radar / 페이션트 레이더

우리 병원이 「지역 × 진료」 키워드에서 네이버(통합검색·플레이스)·구글·카카오맵에 어디에, 몇 번째로 잡히는지 **주 1회 자동 측정**하고 경쟁 병원과 점유율(SOV)을 비교하는 독립 SaaS. AI 답변 가시성은 시그널이 재고 여기서는 반입만 한다.

- 규격 원천: `~/pflive/PatientRadar_젠스파크_작업지시서_2026-09-22.md`, 정의서 `PatientRadar_서비스정의서_2026-09-22.md`
- 상태(2026-09-23): **v1.0.0** — 허브 SSO 실연결·온보딩 3단계·첫 측정·대시보드·설정·주간 리포트·크론 워커·공급 API·어드민 구현, 로컬 E2E 실데이터 통과, 프로덕션 배포·허브 등록 완료. 파일럿 병원(비디 불당본점) 온보딩 완료.

## 주소
| 용도 | 주소 |
|---|---|
| 앱(검증용 호스트, 도메인 확정 전) | https://patient-radar.pages.dev |
| 허브 카드·SSO 진입 | 허브 대시보드 → 페이션트 레이더 카드 (`/api/auth/hub`) |
| 어드민 | `/admin` (ADMIN_SECRET) · JSON `/api/admin/summary` (Bearer) |
| 크론 워커 | https://patient-radar-cron.sodanstjrwns.workers.dev/run?job=status|measure|reports (Bearer CRON_SECRET) |
| 헬스 | `/health` (ps-monitor 감시 대상) |

## 구조
- Hono + Vite + Cloudflare Pages, D1 `patient-radar-production`(마이그레이션 0001~0004), 워커 `patient-radar-cron`(KV STATE).
- `src/lib/measure.ts` 측정 오케스트레이터(재개 가능한 배치, 마무리 시 평판·시그널·주간 점수·경보) · `src/lib/scoring.ts` 점수 규칙 · `src/lib/keywords.ts` 「지역 × 진료」 자동 생성 · `src/lib/report.ts` 주간 리포트(화면·메일 공통).
- 수집기 `src/collectors/`: `naver-html.ts`(HTML 모드), `naver-api.ts`(공식 검색 API: 지역 상위 5·블로그·카페), `google.ts`(Custom Search·Places), `kakao.ts`(로컬 REST), `signal.ts`(시그널 반입). 키 없는 플랫폼은 **미측정**(분모 제외).
- 라우트 `src/routes/`: `auth.ts`(허브 SSO, hub_user_id→email→hid 매칭), `app.ts`(온보딩·첫 측정·대시보드·설정·리포트), `cron.ts`(크론·공급 API·어드민).

## 네이버 수집 방식 — 원장 결정 사항
- `m.search.naver.com`·`m.place.naver.com` robots.txt 는 일반 봇에 `Disallow: /`(2026-09-23 확인). 시그널의 네이버 AI 브리핑 전략이 같은 페이지를 매일 읽고 있다.
- **HTML 모드** `NAVER_HTML_MODE=true`(wrangler.jsonc vars): 위와 같은 방식, 키 없음, 순위 전체·리뷰 수·섹션까지. 요청 간 3~7초, 캡차/차단 시 당일 중단+경보.
- **공식 API 모드** `NAVER_CLIENT_ID/SECRET`(developers.naver.com 등록, 무료 25,000회/일): 플레이스 상위 5위까지·블로그/카페 노출. 리뷰 수 없음. 키가 있으면 HTML 모드 값을 지운다.

## 시크릿·변수 (값은 `~/.ps-keys`, 코드·문서에 복사 금지)
Pages `patient-radar`: PS_SSO_SECRET(sso.key) · PS_SERVICE_KEY(radar.key) · CRON_SECRET(radar-cron.key) · ADMIN_SECRET(radar-admin.key) · HUB_API_KEY(hub.key) · 선택: NAVER_CLIENT_ID/SECRET · GOOGLE_CSE_KEY/GOOGLE_CSE_CX · GOOGLE_PLACES_KEY · KAKAO_REST_KEY · SIGNAL_API_URL/SIGNAL_API_KEY · RESEND_API_KEY/MAIL_FROM/OPS_EMAIL. vars: PUBLIC_ORIGIN, NAVER_HTML_MODE.
워커 `patient-radar-cron`: CRON_SECRET(동일 값), vars RADAR_ORIGIN.
허브: RADAR_API_URL/RADAR_API_KEY(=radar.key), `src/routes/sso.ts` SSO_SERVICES.radar, `src/lib/catalog.ts` 카드.

## 개발·검증
```sh
npm ci && npm test && npm run typecheck && npm run build
npm run db:migrate:local            # 로컬 D1
# .dev.vars 에 PS_SSO_SECRET/CRON_SECRET/ADMIN_SECRET/PS_SERVICE_KEY/HUB_API_KEY/NAVER_HTML_MODE=true
npm run dev -- --port 5179
```
- 합성 SSO 로그인: sso.key 로 HS256 JWT(aud `radar`, hid `bdd-001`) → `/api/auth/hub/callback?sso_token=` (마스터 문서 §6 레시피).
- 경쟁 병원 정본 = 허브 프로필(2026-09-25): 온보딩 3단계·설정이 허브 `hospital_profile.competitors`를 먼저 반입하고(없을 때만 플레이스 추천), 저장한 이름·별칭·플레이스 ID는 `PUT /api/v1/hospital-profile/competitors`로 허브에 되돌린다.
- 로컬 E2E(2026-09-23): 온보딩 → 첫 측정 37초 → 총점 51.5 · 천안 임플란트 플레이스 3위 · 경쟁 3곳 리뷰 수까지 → 대시보드·리포트·`/api/v1/signals`·크론 `due`/`run-hospital`/`weekly-reports` 통과.

## 배포
```sh
npm run deploy:prod                                   # Pages
npm run db:migrate:remote                             # D1 (--remote)
cd cron-worker && npx wrangler deploy --config wrangler.jsonc
```
크론: `0 18 * * 1-5`(03:00 KST 월~금, 병원 id%5 요일 분산·L 플랜 목요일 추가) / `30 23 * * 0`(월 08:30 KST 지난주 리포트). 월 상한은 '수집한 날짜 수'(S/M 5일, L 10일).

## 규칙
- 환자 PII 없음. 미노출도 저장(shown=0, rank NULL). 미측정은 0점이 아니라 분모 제외. 거짓 200 금지.
- 대시보드·리포트·공급 API는 `weekly_scores`만 읽고, 관측치는 최신 run 1회분만 본다.
- 공식 연락처만(010-4445-1873 / patientsfunnel@gmail.com). 실측 없는 숫자 금지.
