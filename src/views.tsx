import { APP_NAME, CONTACT, VERSION } from "./lib/config";
import type { Child } from "hono/jsx";
import { PLANS } from "./lib/pricing";
import { raw } from "hono/html";
const Logo = () => (
  <a href="/" class="brand" aria-label="페이션트 레이더 홈">
    <span class="logo-mark">
      <span />
    </span>
    <span>
      patient<span class="brand-light">radar</span>
      <small>페이션트 레이더</small>
    </span>
  </a>
);
export function Layout({
  title,
  children,
}: {
  title: string;
  children: Child;
}) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex,nofollow" />
          <title>
            {title} · {APP_NAME.en}
          </title>
          <meta
            name="description"
            content="지역 × 진료 키워드로 우리 병원의 플랫폼 노출을 측정하는 페이션트 레이더. 현재 파일럿 준비 중입니다."
          />
          <link
            rel="stylesheet"
            href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css"
          />
          <link rel="stylesheet" href="/static/style.css" />
        </head>
        <body>
          <a class="skip-link" href="#main">
            본문으로 건너뛰기
          </a>
          <header class="site-header">
            <nav class="container nav">
              <Logo />
              <div class="nav-links">
                <a href="/#measurement">측정 항목</a>
                <a href="/#workflow">이용 방법</a>
                <a href="/pricing">요금 안내</a>
              </div>
              <a
                href="/api/auth/hub"
                class="button button-small button-outline"
              >
                허브 계정으로 시작 <span aria-hidden="true">↗</span>
              </a>
            </nav>
          </header>
          {children}
          <footer class="site-footer">
            <div class="container">
              <div class="footer-top">
                <Logo />
                <p>
                  시그널이 AI를 본다면,
                  <br />
                  레이더는 플랫폼을 봅니다.
                </p>
                <div>
                  <a href="/terms">이용약관</a>
                  <a href="/privacy">개인정보처리방침</a>
                  <a href="/refund">환불 안내</a>
                </div>
              </div>
              <div class="footer-bottom">
                <span>
                  Patient Funnel · {CONTACT.phone} ·{" "}
                  <a href={"mailto:" + CONTACT.email}>{CONTACT.email}</a>
                </span>
                <span>개발 검증판 · {VERSION}</span>
              </div>
              <p class="footer-note">
                사업자 정보 및 도메인 확정 전입니다. 현재 가입·결제·정기 측정은
                제공하지 않습니다.
              </p>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}
const Platforms = () => (
  <div class="platform-strip">
    <span>측정 대상 플랫폼</span>
    <strong>
      <b class="naver-letter">N</b> 네이버
    </strong>
    <strong>
      <b class="google-letter">G</b> Google
    </strong>
    <strong>
      <b class="kakao-letter">K</b> 카카오맵
    </strong>
    <strong>
      <b class="signal-letter">✳</b> Patient Signal
    </strong>
    <small>플랫폼별 연결 및 수집 검증 후 제공</small>
  </div>
);
export function Landing() {
  return (
    <Layout title="광고비 앞에서 먼저 볼 숫자">
      <main id="main">
        <section class="hero container" id="hero-section">
          <div class="hero-content">
            <p class="eyebrow">
              <span class="status-dot" /> PLATFORM VISIBILITY · PILOT
              PREPARATION
            </p>
            <h1>
              우리 병원,
              <br />
              네이버·구글·카카오에서
              <br />
              <em>몇 번째?</em>
            </h1>
            <p class="hero-description">
              지역 × 진료 키워드로 주 1회 자동 측정.
              <br />
              경쟁 병원과 점유율까지.
            </p>
            <div class="hero-actions">
              <a class="button button-primary" href="/api/auth/hub">
                허브 계정으로 시작 <span aria-hidden="true">↗</span>
              </a>
              <a class="text-link" href="#measurement">
                무엇을 측정하나요? <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p class="hero-note">
              현재 수집·연동 검증 중 · 체험 오픈 전 · 카드 등록 없음
            </p>
          </div>
          <aside
            class="radar-visual"
            aria-label="측정 전 상태를 표현한 레이더 그래픽, 실제 관측 데이터 아님"
          >
            <div class="radar-top">
              <span>
                <span class="status-dot" /> PATIENT RADAR
              </span>
              <span class="muted">SYSTEM PREPARATION</span>
            </div>
            <div class="radar-dial">
              <div class="radar-axis" />
              <div class="radar-sweep" />
              <div class="radar-center">
                <span class="radar-center-symbol">◎</span>
                <strong>우리 병원</strong>
                <small>측정 연결 대기</small>
              </div>
              <span class="radar-tag tag-naver">
                N <span>네이버</span>
              </span>
              <span class="radar-tag tag-google">
                G <span>Google</span>
              </span>
              <span class="radar-tag tag-kakao">
                K <span>카카오맵</span>
              </span>
              <span class="radar-tag tag-signal">
                ✳ <span>시그널</span>
              </span>
            </div>
            <div class="radar-bottom">
              <span>온라인 가시성 점수</span>
              <strong>
                — <small>/ 100</small>
              </strong>
              <p>첫 실측 전에는 점수를 만들지 않습니다.</p>
            </div>
            <small class="visual-caption">
              서비스 개념도 · 실제 대시보드나 측정 결과가 아닙니다.
            </small>
          </aside>
        </section>
        <section class="container">
          <Platforms />
        </section>
        <section class="section container" id="measurement">
          <div class="section-heading">
            <div>
              <p class="eyebrow">WHAT WE MEASURE</p>
              <h2>
                광고비 앞에서
                <br />
                먼저 볼 숫자.
              </h2>
            </div>
            <p>
              얼마나 많이 썼는지보다,
              <br />
              환자가 찾는 곳에 우리 병원이 보이는지.
            </p>
          </div>
          <div class="feature-grid">
            <article class="feature-card">
              <span class="feature-number">01 / VISIBILITY</span>
              <span class="feature-icon" aria-hidden="true">
                ⌕
              </span>
              <h3>검색하면, 보이는가</h3>
              <p>
                지역과 진료 키워드별 자연 노출 순위.
                <br />
                광고는 구분하고, 미노출도 기록합니다.
              </p>
              <div class="feature-meta">
                노출 여부 <span>·</span> 자연 순위 <span>·</span> 섹션
              </div>
            </article>
            <article class="feature-card">
              <span class="feature-number">02 / SHARE OF VOICE</span>
              <span class="feature-icon" aria-hidden="true">
                ▥
              </span>
              <h3>같은 지역, 다른 존재감</h3>
              <p>
                같은 키워드에서 본원과 경쟁 병원을 비교.
                <br />
                우리 병원의 노출 점유율을 확인합니다.
              </p>
              <div class="feature-meta">
                경쟁사 비교 <span>·</span> 점유율
              </div>
            </article>
            <article class="feature-card">
              <span class="feature-number">03 / REPUTATION</span>
              <span class="feature-icon" aria-hidden="true">
                ↗
              </span>
              <h3>이번 주, 무엇이 달라졌나</h3>
              <p>
                리뷰 수와 주간 노출의 변화를 추적.
                <br />
                숫자가 쌓여야 추세를 보여줍니다.
              </p>
              <div class="feature-meta">
                리뷰 수 추세 <span>·</span> 주간 리포트
              </div>
            </article>
          </div>
          <p class="section-note">
            위 항목은 제품 제공 예정 범위입니다. 현재는 발판 검증 단계이며,
            플랫폼별 수집 가능 여부를 확인하고 있습니다.
          </p>
        </section>
        <section class="workflow-section" id="workflow">
          <div class="container">
            <p class="eyebrow">A SIMPLE WEEKLY ROUTINE</p>
            <h2>
              설정은 한 번.
              <br />
              확인은 매주.
            </h2>
            <div class="workflow-grid">
              <article>
                <span>01</span>
                <h3>병원을 확인하고</h3>
                <p>
                  허브 계정과 네이버 플레이스로
                  <br />
                  우리 병원을 연결합니다.
                </p>
              </article>
              <article>
                <span>02</span>
                <h3>키워드와 경쟁사를 선택</h3>
                <p>
                  지역 × 진료 조합을 바탕으로
                  <br />
                  측정할 범위를 정합니다.
                </p>
              </article>
              <article>
                <span>03</span>
                <h3>주간 변화를 확인</h3>
                <p>
                  대시보드와 리포트에서
                  <br />
                  노출·점유율·평판을 봅니다.
                </p>
              </article>
            </div>
          </div>
        </section>
        <section class="container section">
          <div class="principles">
            <div>
              <p class="eyebrow">MEASURE. DON'T MAKE UP.</p>
              <h2>
                안 보이는 것도 데이터.
                <br />안 잰 것은 <em>미측정.</em>
              </h2>
            </div>
            <ul>
              <li>미측정 플랫폼을 0점으로 계산하지 않습니다.</li>
              <li>환자 정보와 리뷰 본문을 수집하지 않습니다.</li>
              <li>로그인·캡차·robots 제한을 우회하지 않습니다.</li>
              <li>실측 없는 성과나 순위를 만들지 않습니다.</li>
            </ul>
          </div>
          <div class="signal-panel">
            <span class="signal-letter">✳</span>
            <div>
              <p class="eyebrow">BETTER TOGETHER</p>
              <h3>시그널이 AI를 본다면, 레이더는 플랫폼을 봅니다.</h3>
              <p>AI 가시성 + 플랫폼 가시성 = 온라인 가시성</p>
            </div>
            <a href="https://patientsignal.kr" class="text-link">
              시그널 알아보기 ↗
            </a>
          </div>
        </section>
      </main>
    </Layout>
  );
}
export function StatusPage({
  heading,
  text,
}: {
  heading: string;
  text: string;
}) {
  return (
    <Layout title={heading}>
      <main id="main" class="container status-page">
        <p class="eyebrow">PATIENT RADAR / PREPARATION</p>
        <h1>{heading}</h1>
        <p>{text}</p>
        <div class="status-callout">
          <strong>측정하지 않은 숫자는 보여드리지 않습니다.</strong>
          <p>
            실측과 연동 검증이 끝난 뒤 서비스를 시작합니다. 준비 중인 기능을
            완료된 것처럼 안내하지 않겠습니다.
          </p>
        </div>
        <a class="button button-primary" href="/">
          홈으로 돌아가기 ↗
        </a>
        <p class="muted">
          문의 <a href={"mailto:" + CONTACT.email}>{CONTACT.email}</a>
        </p>
      </main>
    </Layout>
  );
}
export function Pricing() {
  const plans = PLANS;
  return (
    <Layout title="요금 안내">
      <main id="main" class="container section">
        <p class="eyebrow">PLANS / COMING SOON</p>
        <h1>병원에 맞는 측정 범위.</h1>
        <p class="hero-description">
          금액 안내 준비 중입니다.
          <br />
          오픈 후 14일 무료 체험 · 카드 등록 없음
        </p>
        <div class="pricing-grid">
          {plans.map((plan) => (
            <article
              class={"price-card " + (plan.name === "M" ? "featured" : "")}
            >
              <h2>{plan.name}</h2>
              <p class="price-label">
                {plan.name === "FREE" ? "무료 플랜 예정" : "금액 확정 전"}
              </p>
              <ul>
                <li>키워드 {plan.keywords}개</li>
                <li>경쟁사 {plan.competitors}곳</li>
                <li>{plan.channels}</li>
                <li>{plan.cycle} 측정</li>
              </ul>
              <span class="plan-badge">제공 준비 중</span>
            </article>
          ))}
        </div>
        <p class="section-note">
          유료 플랜 월 요금 VAT 별도 · 연 결제는 10개월치 요금 · 결제와 구독
          관리는 허브에서만 제공됩니다. 현재 결제는 받지 않습니다.
        </p>
      </main>
    </Layout>
  );
}
export function Legal({ kind }: { kind: "terms" | "privacy" | "refund" }) {
  const title = {
    terms: "이용약관",
    privacy: "개인정보처리방침",
    refund: "환불 안내",
  }[kind];
  return (
    <Layout title={title}>
      <main id="main" class="container legal section">
        <p class="eyebrow">POLICY / DRAFT</p>
        <h1>{title}</h1>
        <p class="notice">
          출시 전 검토용 초안입니다. 사업자 정보·시행일·수탁 관계 확정 후 정식
          정책으로 게시합니다. 현재 가입·결제를 받지 않습니다.
        </p>
        {kind === "terms" ? (
          <>
            <h2>서비스의 목적과 범위</h2>
            <p>
              본 서비스는 병원이 등록한 키워드로 공개된 검색 결과·지도 정보를
              주기적으로 수집해 노출 순위·리뷰 수를 기록합니다. 환자 정보 및
              리뷰 작성자를 식별하는 정보는 수집하지 않습니다.
            </p>
            <h2>측정 결과의 해석</h2>
            <p>
              검색 결과는 시점·위치·플랫폼 정책에 따라 달라집니다. 측정은 정해진
              환경의 관측이며 특정 순위나 매출을 보장하지 않습니다. 측정하지
              못한 플랫폼은 미측정으로 표시합니다.
            </p>
            <h2>이용과 제한</h2>
            <p>
              허브 계정으로 이용하며 설정 변경은 원장 권한에 한합니다. 경쟁사
              정보는 권한이 있는 병원 구성원의 내부 화면과 등록된 수신자용
              메일에서만 제공합니다. 공개 공유 기능은 제공하지 않습니다.
            </p>
            <h2>수집 원칙</h2>
            <p>
              공식 API 및 접근이 허용된 공개 페이지만 이용합니다.
              robots·로그인·캡차 제한을 우회하지 않습니다. 제한 발생 시 수집을
              중단할 수 있습니다.
            </p>
          </>
        ) : kind === "privacy" ? (
          <>
            <h2>처리 항목과 목적</h2>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>구분</th>
                    <th>항목</th>
                    <th>목적</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>병원 계정</td>
                    <td>허브 사용자 ID, 이름, 이메일, 역할, 병원 ID</td>
                    <td>SSO 인증·병원별 권한 관리</td>
                  </tr>
                  <tr>
                    <td>병원 설정</td>
                    <td>
                      병원명, 지역, 진료, 홈페이지, 플레이스 ID, 키워드, 경쟁사
                    </td>
                    <td>측정 대상 관리</td>
                  </tr>
                  <tr>
                    <td>관측 데이터</td>
                    <td>노출 여부·순위·리뷰 건수·평점</td>
                    <td>주간 점수·추세 집계</td>
                  </tr>
                  <tr>
                    <td>리포트 수신</td>
                    <td>병원 계정 및 직원 수신 이메일</td>
                    <td>주간 리포트 발송</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              환자 실명·연락처·차트번호, 리뷰 본문·작성자 정보는 저장하지
              않습니다. 계정 운영을 위한 병원 구성원의 정보와 환자 정보는
              구분합니다.
            </p>
            <h2>보유 및 파기</h2>
            <p>
              서비스 이용 중 보유하며 해지 후 30일 이내 파기하는 것을 원칙으로
              합니다. 법령상 보존 의무가 있는 항목은 해당 의무 확인 후 별도로
              고지합니다.
            </p>
            <h2>인프라 및 외부 서비스</h2>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>서비스</th>
                    <th>사용 목적</th>
                    <th>현재 상태</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Cloudflare</td>
                    <td>앱 실행·데이터 보관</td>
                    <td>검증용 사용</td>
                  </tr>
                  <tr>
                    <td>Resend</td>
                    <td>이메일 발송</td>
                    <td>연결 전</td>
                  </tr>
                  <tr>
                    <td>Google</td>
                    <td>공식 검색·Places API</td>
                    <td>연결 전</td>
                  </tr>
                  <tr>
                    <td>Kakao</td>
                    <td>공식 로컬 API</td>
                    <td>연결 전</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              국외 이전 해당 여부·이전 국가·법적 근거·수탁 계약과 세부 항목은
              출시 전 확인하여 고지해야 합니다. 이 초안으로 개인정보 수집 동의를
              받지 않습니다.
            </p>
            <h2>권리 행사</h2>
            <p>
              병원 계정의 열람·정정·삭제·처리 정지 요청은 아래 공식 연락처로
              접수할 수 있습니다.
            </p>
          </>
        ) : (
          <>
            <h2>환불 기준</h2>
            <p>
              결제 후 7일 이내 미사용 시 전액 환불, 이후에는 일할 환불을
              원칙으로 합니다. 실제 결제·구독·환불 처리는 허브에서 진행합니다.
            </p>
            <h2>체험과 요금</h2>
            <p>
              오픈 후 14일 무료 체험은 카드 등록 없이 제공할 예정입니다. 월
              요금은 VAT 별도, 연 결제는 10개월치 기준입니다. 금액은 아직
              확정되지 않았으며 현재 레이더에서는 결제를 받지 않습니다.
            </p>
            <h2>신청 방법</h2>
            <p>
              허브 결제 내역을 확인한 뒤 공식 연락처로 요청해 주세요. 환불 처리
              기한과 세부 정산 방식은 출시 전 정식 정책에 명시합니다.
            </p>
          </>
        )}
        <h2>공식 문의</h2>
        <p>
          {CONTACT.phone} /{" "}
          <a href={"mailto:" + CONTACT.email}>{CONTACT.email}</a>
        </p>
        <p class="muted">
          사업자명·대표자·사업자등록번호·주소·통신판매업 신고 정보: 발주자 확인
          대기
        </p>
      </main>
    </Layout>
  );
}
