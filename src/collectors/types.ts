// 수집기 공통 타입. 수집기는 의존성 없이(fetch만) 동작해야 로컬 probe 와 Pages 양쪽에서 같은 코드가 돈다.
export type Entity = {
  key: string;
  name: string;
  aliases: string[];
  placeId?: string | null;
};

export type SerpPlaceCard = {
  placeId: string;
  name: string;
  isAd: boolean;
  position: number;
};

export type NaverSerpResult = {
  keyword: string;
  fetchedAt: string;
  blocked: boolean;
  htmlLength: number;
  sections: Record<string, boolean>; // place / blog / cafe / influencer / ai_briefing / kin / ad
  placeCards: SerpPlaceCard[]; // 통합검색 플레이스 섹션 카드(광고 포함, 순서대로)
  aiBriefingShown: boolean;
  entities: Record<
    string,
    {
      // entity.key → 노출 판정
      shown: boolean;
      placeRank: number | null; // 광고 제외 자연 순위
      placeAd: boolean;
      mentions: number; // SERP 전체 텍스트 내 이름 등장 횟수
      aiBriefingMentioned: boolean;
    }
  >;
};

export type NaverPlaceSnapshot = {
  placeId: string;
  name: string | null;
  category: string | null;
  roadAddress: string | null;
  visitorReviews: number | null;
  blogReviews: number | null;
  fetchedAt: string;
  /** 플레이스 완성도(2026-09-26) — 페이지 상태값에서 그대로 읽은 것만. 없으면 null */
  completeness?: PlaceCompleteness;
};
export type PlaceCompleteness = {
  photos: number | null;            // 사진 탭 총 장수(topPhotos.total)
  businessImages: number | null;    // 업체 등록 사진(totalImages)
  descriptionLen: number | null;    // 소개글 글자수
  descriptionMissing: boolean | null;
  bizHourMissing: boolean | null;   // 영업시간 항목(WorkingHoursInfo) 없음. 네이버 MissingInfo 플래그는 신뢰 못 해 안 씀
  booking: boolean;                 // 네이버 예약 연결
  talktalk: boolean;                // 톡톡 연결
  keywordList: string[];            // 대표 키워드(업체가 등록한 5개)
  blogLinked: boolean;              // 블로그 연결(recentBlogPost 또는 홈페이지 목록의 블로그)
  homepage: boolean;                // 홈페이지 URL 등록
  imageReviews: number | null;      // 사진 리뷰 수
  textReviews: number | null;       // 텍스트 리뷰 수
  conveniences: number;             // 편의시설 항목 수
};
