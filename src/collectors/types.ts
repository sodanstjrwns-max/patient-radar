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
};
