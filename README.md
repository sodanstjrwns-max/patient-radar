# Patient Radar / 페이션트 레이더

지역 × 진료 키워드의 공개 플랫폼 노출을 주간 단위로 측정하는 독립 SaaS. 발주자의 `PatientRadar_젠스파크_작업지시서_2026-09-22.md`가 우선 규격이며, §12 법·수집 규칙은 완화하지 않는다.

## 현재 상태 — v0.1.0-foundation

**1단계 발판의 부분 구현·배포 및 수집 사전검증까지 진행했다. v1.0.0 완료나 파일럿 오픈 상태가 아니다.**

- GitHub `sodanstjrwns-max/patient-radar`는 접근 승인 후 `git ls-remote`로 비어 있음을 확인했다. 기존 골격을 덮어쓴 것이 아니라 지시서 부록 A/B에서 수집기·점수·스키마를 복원했다.
- 원본 `src/lib/hub-sso.ts`는 저장소와 부록에 없다. 임의 구현·복제·우회 인증은 하지 않았으며 SSO는 503으로 닫혀 있다.
- 네이버 공개 HTML 수집은 robots 제한으로 중단했다. 구글·카카오·시그널은 아직 미연결이다.
- 실제 병원·키워드·경쟁사·노출 관측 데이터는 생산 DB에 넣지 않았다. 과거 로컬 실측 로그를 현재 결과로 재사용하지 않았다.

## 실제 Cloudflare 사전검증 결과

증거: `artifacts/cloudflare-probe.json`, 운영 D1 `probe_runs`와 `alerts`.

| 항목 | 결과 |
|---|---|
| 환경 | 발주자 소유 Cloudflare Pages, patient-radar |
| 실제 시각 | 2026-09-23 00:07:24~00:07:34 KST (UTC 2026-09-22) |
| 모바일 검색 robots | HTTP 200, `Disallow: /`, PatientRadar 수집 허용 안 됨 |
| 플레이스 robots | HTTP 429, 허용 정책 확인 불가 |
| 검색 결과 본문 요청 | **0회** |
| 카드 수·HTML 길이·캡차 | **미측정** (0개 또는 캡차 없음으로 해석하면 안 됨) |
| 예정된 3회 검색 요청 | 모두 생략 |
| 판정 | `policy_blocked` / `ROBOTS_DISALLOWED`, HTTP 424 |
| 15키워드 실행 시간 | 미검증 — 허용되지 않은 수집을 부하 테스트하지 않음 |

다른 IP·프록시·브라우저 자동화·Yeti 사칭으로 robots 정책을 우회하지 않는다. 실행 환경만 바꾸는 것은 이 제한의 해결책이 아니다. 공식 제공 범위·명시적 허용 등 적법하고 정책에 부합하는 수집 경로를 먼저 확정해야 한다. 그때까지 네이버는 미측정이다.

검증용 `POST /api/admin/probe/naver`는 `PROBE_ENABLED=false`로 닫는다. 재개하려면 수집 허용 근거 검토 후 운영자가 설정·배포해야 한다. robots 검사 자체가 429/403/401을 반환하는 경우도 이후 구현에서는 당일 중단으로 기록한다.

## 구현한 기능

- Hono + Vite + Cloudflare Pages, 독립 D1, 헬스체크.
- 부록 기반 네이버 SERP·플레이스 파서와 로컬 probe. ID 우선 매칭, 자연/광고 동시 등장 보존 수정.
- 보수적 robots 검사, 자동 리다이렉트 금지, 리다이렉트 대상 재검사, 호스트 제한, 요청 간 3~7초 지연, HTTP/캡차 차단 중단.
- 인증된 고정 키워드 Cloudflare probe, D1 글로벌 lease lock, 시크릿 없는 결과·경보 보관. HTML 본문·리뷰 본문은 DB에 저장하지 않는다.
- 순위 점수표·가중 합·SOV 순수 함수. 미측정 null, 경쟁사 0곳 SOV null, 측정된 0점과 미측정의 구분, 잘못된 점수/플랫폼/서로 다른 비교 세트 거부.
- HMAC 서명 쿠키 유틸리티와 위변조 테스트. **실제 허브 로그인에 연결된 것은 아니다.** 병원 세션은 14일, HttpOnly·Secure·SameSite=Lax, PS_SSO_SECRET 사용. 운영 세션은 별도 ADMIN_SECRET 사용.
- 공급 API의 503/401/400/404 방어 계약. 매핑된 병원이라도 성공 신호 규격·측정 구현 전에는 503 반환.
- 반응형 랜딩, 요금 안내, 약관·개인정보·환불 초안. 실제 대시보드가 아닌 개념도를 명시하고 `— / 100` 표시. 가짜 성과·후기·가격 없음.
- 검색 색인 차단, CSP, no-referrer, 민감 API no-store.

## URL 및 이용 방법

- GitHub: https://github.com/sodanstjrwns-max/patient-radar (private)
- 검증 배포: https://patient-radar.pages.dev — **운영 검증 전용. 사용자 로그인 주소로 안내하지 않는다.**
- 화면 검토용 샌드박스: https://3000-i0d8s10zos6bs9txwi8mj-2b54fc91.sandbox.novita.ai (임시)
- 서비스 도메인 기본값: `PUBLIC_ORIGIN=https://patientradar.kr`. 소유·DNS·연결 확정 전이며 현재 연결하지 않았다.
- 이름: `src/lib/config.ts`의 `APP_NAME`, 가격/티어 안내: `src/lib/pricing.ts`, 점수: `src/lib/scoring.ts`.

현재는 공개 안내 화면만 검토할 수 있다. 가입 CTA는 허브 연동 대기 안내(503)로 이동한다. 병원 정보를 입력받거나 무료 체험을 시작하지 않는다. 법률 페이지도 출시 전 초안이며 확정 전 동의 수집에 쓰지 않는다.

### 엔드포인트

| 경로 | 상태 / 인증 |
|---|---|
| `GET /`, `/pricing` | 공개 개발 검증 안내, 200 |
| `GET /terms`, `/privacy`, `/refund` | 출시 전 정책 초안, 200 |
| `GET /health` | DB 연결 확인; 서비스 준비 상태는 false |
| `GET /api/auth/hub`, `/api/auth/hub/callback` | 원본 검증 코드·시크릿·허브 등록 대기, 503 |
| `GET /app`, `/app/*`, `/admin` | 미구현 안내, 503. 데이터 미노출 |
| `GET /api/admin/summary` | Bearer ADMIN_SECRET, 수집 사전검증 상태·설정 존재 여부만 |
| `GET /api/admin/probe/latest` | Bearer ADMIN_SECRET, 직전 사전검증 결과 |
| `POST /api/admin/probe/naver` | Bearer ADMIN_SECRET, 고정 키워드, 현재 비활성 403 |
| `GET /api/v1/signals` | PS_SERVICE_KEY + X-PS-Hospital-Id; 오류 계약만 구현. 성공 신호와 since는 미구현 |
| `POST /api/cron/run-hospital/:id` | CRON_SECRET; 실제 실행 미구현, 인증 성공해도 503 |

현재 운영 UI 로그인 폼은 없으며, 테스트 유틸리티가 세션을 발급하는 공개 엔드포인트도 없다. 시크릿 유무만 응답에 표시하며 값은 절대 반환하지 않는다.

## 데이터와 마이그레이션

Cloudflare D1 `patient-radar-production`, 바인딩 `DB`. 애플리케이션 영속 데이터를 메모리·런타임 파일에 저장하지 않는다.

| 파일 | 내용 | 로컬 / 프로덕션 |
|---|---|---|
| `0001_init.sql` | 부록 9개 표, 원본 유지 | 적용 / 적용 |
| `0002_reports.sql` | weekly_reports, hospital_settings, 병원 열 확장 | 적용 / 적용 |
| `0003_probe_safety.sql` | probe_runs, operation_locks, collection_pauses 및 중복 방지 인덱스 | 적용 / 적용 |

SQLite의 UNIQUE에서 NULL은 서로 다른 값으로 취급되므로, self 관측·평판의 entity_id를 `COALESCE(entity_id,0)`으로 정규화한 추가 인덱스를 적용했다. 운영 DB에는 probe 결과와 운영 경보만 있다. 미래 병원 해지 시 observations·reputation_snapshots 등 원본 0001에서 FK 없는 표의 파기도 명시적으로 구현해야 한다. 현재 자동 파기 잡은 미구현이다.

날짜/주 경계 계산은 `src/lib/time.ts`에서 KST 기준. 부록의 기존 SQLite 기본 타임스탬프는 보존했으며, 새 운영 코드에서 쓰는 시각은 KST ISO8601이다. 후속 데이터 저장 코드도 명시적으로 시각을 전달해야 한다.

## 검증

- `npm test`: 69개 단위·API 테스트 통과.
- `npm run typecheck`: 통과.
- `npm run build`: 통과, Worker 번들 약 70KB.
- `node scripts/check-browser.mjs`: 1440 / 768 / 390 / 320px × 공개 5페이지, 20회 검사 통과. 가로 넘침 0, JS pageerror 0, CTA 대기 안내 이동 확인. 콘솔 별도 검사에서도 오류 0.
- `artifacts/browser-checks.json`, `artifacts/screenshots/landing-*.png`에 화면 검증 결과.
- 격리 SQLite fixture로 같은 날 실행 중복, self 관측 중복, self 평판 중복 거부 및 shown=0/rank=NULL 저장 확인. **실제 병원 수집 성공 테스트가 아니다.**
- 네이버 순위 실측·15키워드 실행·실제 SSO·메일 발송·주간 크론·테넌트 간 권한 검증은 아직 통과한 것으로 보고하지 않는다.

## 개발 및 배포

```sh
npm ci
npm run db:migrate:local
npm test
npm run typecheck
npm run build
# 샌드박스에서는 포트 3000 정리 후 PM2 사용
pm2 start ecosystem.config.cjs
curl http://localhost:3000/health
node scripts/check-browser.mjs
# BYOK 인증 설정을 완료한 뒤에만
npm run db:migrate:remote
npm run deploy:prod
```

브라우저 검증 도구가 없는 Linux 환경에서는 `npx playwright install --with-deps chromium` 필요. Node 전용 API는 scripts/tests에만 쓰고 Worker 런타임에서는 사용하지 않는다.

- Cloudflare 리소스: Pages `patient-radar`, D1 `patient-radar-production`만 새로 생성. 허브·시그널·기존 서비스 DB는 수정하지 않았다.
- 새 검증용 `ADMIN_SECRET`을 강한 난수로 생성해 Cloudflare Pages Secret에 주입했다. 로컬 `.dev.vars`는 0600, gitignore 대상. 키 값은 코드·응답·문서·채팅에 쓰지 않는다. 운영 인수 시 안전하게 교체할 수 있다.
- PS_SSO_SECRET / PS_SERVICE_KEY / CRON_SECRET은 제공되지 않아 설정하지 않았다. 공유 SSO 키를 새로 만들지 않는다.
- 앱 관련 시크릿은 Pages Secret으로만 주입한다. 배포 후 재배포가 필요하다. `.dev.vars`, .env, 키 파일을 커밋하지 않는다.
- 정기 Worker, KV, R2, 메일, 커스텀 DNS는 이번 단계에서 생성·배포하지 않았다.

## 미구현 및 다음 단계

1. 네이버에 대한 허용 수집 경로 확보. 허용 전 미측정 유지. 허용된 공식 구글·카카오 API를 먼저 구현하는 방향을 발주자에게 확인.
2. 수정 금지 공통 `src/lib/hub-sso.ts` 원본과 `PatientSeries_통합지시서_공용.md` §1 제공. 허브 검증·state·세션 소비·테넌트 및 role 권한을 실제 연결.
3. 허브 SSO_SERVICES.radar / catalog 카드 등록은 발주자가 수행. 시크릿 안전 주입 및 재배포.
4. 온보딩·키워드 생성·경쟁사 추천·SSE·대시보드·설정 구현. 시범 hid bdd-001 병원도 아직 생성하지 않았다.
5. 주간 집계·경쟁사 비교·평판 추세·공급 API 성공 신호·since·플랜 게이트·관리 UI 구현.
6. 크론 Worker·병원 순차 실행·날짜 기준 월 상한·초기 5키워드 후 나머지 재개·주간 메일·당일 차단·해지 데이터 파기 구현.
7. 구글·카카오·시그널 키가 없으면 미측정. 카카오 비공식 평판 JSON은 §12에 따라 사용하지 않는다.

## 확인 필요 — 문서 충돌 및 발주자 결정

- `0 18 * * 1-5`는 KST 화~토 03시이다. 월~금 의도에 맞는 식은 `0 18 * * 0-4`. 아직 크론을 배포하지 않았다.
- L 플랜: 기본 측정일이 목요일인 병원은 '목요일 추가'와 같은 날 중복 금지 규칙이 충돌한다. 두 번째 요일을 확정해야 한다.
- 첫 5개 즉시 측정 후 그날 밤 나머지 키워드 완료는 별도 run이 아니라 같은 run의 재개로 설계해야 한다.
- 구글 검색과 Places를 한 `google:20` 점수로 합치는 내부 비중은 미정이다. 임의로 동일 비중을 정하지 않는다.
- 부록의 SERP 전체 텍스트 mentions / 넓은 AI 텍스트 창은 오탐 위험이 있다. 실제 관측을 켜기 전에 섹션별 이름 등장과 광고만 등장한 경우를 더 정밀 검증해야 한다. 순수 rankScore의 adOnly 플래그 지원만으로 수집기의 섹션 판정까지 완료된 것은 아니다.
- 점수·가격·가중치·이름·도메인·Places 검색 순서 근사 허용·Resend 발신 도메인·OPS_EMAIL·시그널 점수 응답·파일럿 목록은 §17대로 최종 확인 필요.
- 사업자 표기와 개인정보 국외 이전·수탁 정보가 미확정이다. 허위 사업자 정보나 법적 확정 문구를 만들지 않는다.
- 경쟁사 노출 범위에 대해 §4 실장 동일 화면과 §12 원장만 보는 화면의 적용 범위 확인 필요.

## [Radar 1단계 중간보고]

- 단계: 1 진행, 수집 정책 및 SSO 원본 부족으로 완료 보류.
- 버전: v0.1.0-foundation. v1.0.0은 1단계 수용 기준 충족 후 부여.
- 배포: 발주자 Cloudflare Pages 검증판, PUBLIC_ORIGIN 도메인 미연결.
- 마이그레이션: 0001~0003 프로덕션 적용.
- 새 엔드포인트/파일: 상기 목록 및 Git 변경 이력 참조.
- 실측: 검색 robots Disallow /, 플레이스 robots 429, 본문 수집 0회. 캡차/카드 수/15키워드 실행 시간 미측정.
- 미구현: 실제 SSO·온보딩·병원 측정·집계·크론·메일·타 플랫폼 수집.
- 발주자 작업: 공통 SSO 원본과 PS API 규약 제공, 시크릿 주입, 허브 등록 및 수집 허용 경로 결정.
