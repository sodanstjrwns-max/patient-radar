// 처방 규칙 — LLM 없이 실측 신호에서 바로 나오는 행동. 근거가 되는 신호를 문장 앞에 적는다.
export type Signal = {
  keyword: string; term: string;                  // term = 키워드에서 지역명을 뺀 진료어 ("천안 소아치과" → "소아치과")
  placeRank: number | null; placeAd: boolean; mentions: number; blogSection: boolean; cafeSection: boolean; aib: boolean;
  googleRank: number | null | undefined; kakaoRank: number | null | undefined;
  above: { name: string; rank: number; visitorReviews: number | null; blogReviews: number | null }[];
  selfVisitorReviews: number | null; selfBlogReviews: number | null;
};
export function prescribe(s: Signal): string[] {
  const out: string[] = [];
  const t = s.term || s.keyword;
  if (s.placeRank == null) {
    if (s.mentions > 0) out.push(`블로그·카페엔 「${t}」로 우리 글이 잡히는데 플레이스 목록엔 없음 → 플레이스 관리에서 대표 키워드·업종 소개·진료 항목(메뉴)에 「${t}」를 넣고, 예약 후 리뷰 요청 문구에 「${t}」를 넣어 방문자 리뷰에 단어가 쌓이게 하세요.`);
    else out.push(`「${t}」로 플레이스에도 블로그·카페에도 우리 병원이 없음 → 플레이스 대표 키워드·소개·진료 항목에 「${t}」 추가(즉시), 「${s.keyword}」 제목의 원장 칼럼·치료 사례 블로그 글 2편(2주 안), 리뷰 요청 문구에 「${t}」 포함.`);
    if (s.placeAd) out.push(`지금은 이 키워드에서 플레이스 광고로만 노출됨 → 광고를 끄면 사라지는 자리. 위 항목으로 자연 노출을 먼저 만들고 광고는 보조로.`);
  } else if (s.placeRank >= 4) {
    const top = s.above[0];
    const revGap = top && top.visitorReviews != null && s.selfVisitorReviews != null ? top.visitorReviews - s.selfVisitorReviews : null;
    out.push(`${s.placeRank}위는 첫 화면(3위) 밖 → 최근 30일 방문자 리뷰 수·리뷰 응답률·저장 수가 순위를 가릅니다. 이번 달 「${t}」 환자분에게 리뷰 요청을 집중하고 모든 리뷰에 48시간 안에 답하세요.${revGap != null && revGap > 0 ? ` (1위 ${top.name}는 방문자 리뷰가 ${revGap.toLocaleString()}건 더 많음)` : ""}`);
    if (top && top.blogReviews != null && s.selfBlogReviews != null && top.blogReviews > s.selfBlogReviews * 2) out.push(`위에 있는 ${top.name}는 블로그 리뷰 ${top.blogReviews.toLocaleString()}건(우리 ${s.selfBlogReviews.toLocaleString()}) → 블로그 기반 상대. 체험단보다 「${s.keyword}」 제목의 최근 글(최근 3개월) 편수를 맞추는 게 우선.`);
  } else if (s.placeRank <= 3) {
    out.push(`플레이스 ${s.placeRank}위 유지 중 → 주 1회 플레이스 소식 게시, 리뷰 응답 유지. 순위가 내려가면 경보로 알려드립니다.`);
  }
  if (s.blogSection && s.mentions === 0 && s.placeRank != null) out.push(`통합검색 블로그 영역에 우리 글이 없음 → 「${s.keyword}」를 제목에 넣은 글 2편(원장 설명 1 + 사례 1). 플레이스는 있는데 블로그가 비면 4위 밖으로 밀리기 쉽습니다.`);
  if (s.googleRank === null) out.push(`구글 비즈니스 프로필에서 「${t}」로 안 잡힘 → 프로필의 카테고리·서비스 항목에 「${t}」 추가, 「${t}」 업데이트 게시 1회.`);
  if (s.kakaoRank === null) out.push(`카카오맵에서 「${t}」로 안 잡힘 → 카카오맵 매장관리에서 태그·메뉴(진료 항목)에 「${t}」 추가.`);
  return out.slice(0, 4);
}
