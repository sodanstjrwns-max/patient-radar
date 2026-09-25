// 처방 규칙 — LLM 없이 실측 신호에서 바로 나오는 행동. 모든 처방은 code(규칙)·text(행동)·evidence(근거 숫자)를 가진다.
// 규칙: 측정하지 않은 가정을 사실처럼 쓰지 않는다. 순위 요인은 "통설"로 표기한다(2026-09-25 원장 지적).
export type Signal = {
  keyword: string; term: string;                  // term = 키워드에서 지역명을 뺀 진료어 ("천안 소아치과" → "소아치과")
  placeRank: number | null; blockSize: number | null; placeAd: boolean; mentions: number; blogSection: boolean; cafeSection: boolean; aib: boolean;
  googleRank: number | null | undefined; kakaoRank: number | null | undefined;
  above: { name: string; rank: number; visitorReviews: number | null; blogReviews: number | null }[];
  selfVisitorReviews: number | null; selfBlogReviews: number | null;
  selfKeywordList?: string[] | null;             // 우리 플레이스 대표 키워드(완성도 스냅샷). 모르면 null
  gain?: number;                                  // 한 계단 오르면 +N명
};
export type Rx = { code: string; text: string; evidence: string; gain: number };
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function prescribe(s: Signal): Rx[] {
  const out: Rx[] = [];
  const t = s.term || s.keyword;
  const generic = /^(치과|병원|의원|한의원|피부과|성형외과|정형외과|안과|내과|이비인후과|산부인과|소아과|비뇨기과|정신건강의학과)$/.test(t);
  const patients = generic ? "환자분" : `「${t}」 환자분`;
  const gain = s.gain ?? 0;
  const block = s.blockSize && s.blockSize > 0 ? s.blockSize : null;
  const rankTxt = s.placeRank == null ? "플레이스 블록 미노출" : `플레이스 ${s.placeRank}위${block ? `/블록 ${block}개` : ""}`;
  const rx = (code: string, text: string, evidence: string) => out.push({ code, text, evidence, gain });

  // 대표 키워드 누락 — 실측(우리 플레이스 keywordList)에 진료어가 없을 때만
  const kwList = s.selfKeywordList;
  const termInKw = !kwList ? null : kwList.some((k) => norm(k).includes(norm(t)) || norm(t).includes(norm(k)));
  if (kwList && kwList.length && termInKw === false && !generic) {
    rx("place_keyword_missing", `플레이스 대표 키워드 5개에 「${t}」가 없음 → 스마트플레이스 관리에서 대표 키워드에 「${t}」를 넣으세요(즉시, 무료).`, `우리 대표 키워드: ${kwList.join(" · ")} · 「${s.keyword}」 ${rankTxt}`);
  }
  if (s.placeRank == null) {
    if (s.mentions > 0) rx("place_register", `블로그·카페엔 「${t}」로 우리 글이 잡히는데 플레이스 블록엔 없음 → 플레이스 소개·진료 항목에 「${t}」를 넣고, 예약 후 리뷰 요청 문구에 「${t}」를 포함해 방문자 리뷰에 단어가 쌓이게 하세요.`, `${rankTxt} · 통합검색 본문 언급 ${s.mentions}회${s.blogSection ? " · 블로그 섹션 있음" : ""}`);
    else rx("place_absent", `「${t}」로 플레이스에도 블로그·카페에도 우리 병원이 없음 → 플레이스 소개·진료 항목에 「${t}」 추가(즉시), 「${s.keyword}」 제목의 원장 칼럼·치료 사례 글 2편(2주 안), 리뷰 요청 문구에 「${t}」 포함.`, `${rankTxt} · 통합검색 본문 언급 0회${s.above.length ? ` · 블록 위: ${s.above.slice(0, 2).map((a) => `${a.name} ${a.rank}위`).join(", ")}` : " · 등록 경쟁사도 블록에 없음"}`);
    if (s.placeAd) rx("ad_only", `지금은 이 키워드에서 플레이스 광고로만 노출됨 → 광고를 끄면 사라지는 자리. 위 항목으로 자연 노출을 먼저 만들고 광고는 보조로.`, `광고 카드에 우리 병원 있음 · 자연 블록엔 없음`);
  } else if (s.placeRank >= 4) {
    const top = s.above[0];
    const revGap = top && top.visitorReviews != null && s.selfVisitorReviews != null ? top.visitorReviews - s.selfVisitorReviews : null;
    const where = block == null ? `${s.placeRank}위` : s.placeRank <= block ? `${s.placeRank}위 — 통합검색 플레이스 블록 안(${block}개 중 ${s.placeRank}번째)이지만 위에 ${s.placeRank - 1}곳` : `${s.placeRank}위 — 통합검색 플레이스 블록(${block}개) 밖, '더보기'를 눌러야 보임`;
    rx("review_push", `${where} → 통설상 최근 방문자 리뷰 수·답글률·저장 수가 플레이스 순위에 영향을 준다고 알려져 있습니다(네이버가 공개한 기준은 아님). 이번 달 ${patients}에게 리뷰 요청을 집중하고 모든 리뷰에 48시간 안에 답하세요.`, `${rankTxt}${top ? ` · 1위 ${top.name}${revGap != null ? (revGap > 0 ? ` 방문자 리뷰 ${revGap.toLocaleString()}건 더 많음` : revGap < 0 ? ` 방문자 리뷰 ${Math.abs(revGap).toLocaleString()}건 더 적음(리뷰 수만으론 설명 안 됨)` : "") : ""}` : ""}${gain ? ` · 한 계단 오르면 +${gain.toLocaleString()}명` : ""}`);
    if (top && top.blogReviews != null && s.selfBlogReviews != null && top.blogReviews > s.selfBlogReviews * 2) rx("blog_gap", `위에 있는 ${top.name}은 블로그 리뷰가 우리의 ${Math.round(top.blogReviews / Math.max(1, s.selfBlogReviews))}배 → 블로그 기반 상대. 체험단보다 「${s.keyword}」 제목의 최근 글(최근 3개월) 편수를 맞추는 게 우선.`, `블로그 리뷰 ${top.name} ${top.blogReviews.toLocaleString()}건 vs 우리 ${s.selfBlogReviews.toLocaleString()}건`);
  } else {
    rx("keep", `플레이스 ${s.placeRank}위 유지 중 → 주 1회 플레이스 소식 게시, 리뷰 응답 유지. 순위가 내려가면 경보로 알려드립니다.`, `${rankTxt}`);
  }
  if (s.blogSection && s.mentions === 0 && s.placeRank != null) rx("blog_section_empty", `통합검색 블로그 영역에 우리 글이 없음 → 「${s.keyword}」를 제목에 넣은 글 2편(원장 설명 1 + 사례 1). 플레이스만 있고 블로그가 비면 검색 결과에서 우리 이름을 만나는 자리가 하나뿐입니다.`, `통합검색에 블로그 섹션 있음 · 본문에 우리 병원 언급 0회 · ${rankTxt}`);
  if (s.googleRank === null) rx("google_absent", `구글 비즈니스 프로필에서 「${t}」로 안 잡힘 → 프로필의 카테고리·서비스 항목에 「${t}」 추가, 「${t}」 관련 업데이트 게시 1회.`, `구글 Places 검색 「${s.keyword}」 상위 20 미노출`);
  if (s.kakaoRank === null) rx("kakao_absent", `카카오맵에서 「${t}」로 안 잡힘 → 카카오맵 매장관리에서 태그·메뉴(진료 항목)에 「${t}」 추가.`, `카카오맵 검색 「${s.keyword}」 상위 15 미노출`);
  return out.filter((r) => r.evidence.trim()).slice(0, 4);
}
/** 실행 추적 대상: 행동이 있는 처방만(유지 안내 제외) */
export const TRACKABLE = new Set(["place_keyword_missing", "place_register", "place_absent", "ad_only", "review_push", "blog_gap", "blog_section_empty", "google_absent", "kakao_absent"]);
