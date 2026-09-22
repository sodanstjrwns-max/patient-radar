// Monetary values are intentionally unset pending owner confirmation.
export const PRICING = {
  currency: "KRW",
  vatIncluded: false,
  trialDays: 14,
  annualChargedMonths: 10,
  pricesConfirmed: false,
} as const;
export const PLANS = [
  {
    name: "FREE",
    keywords: 3,
    competitors: 0,
    cycle: "월 1회",
    channels: "네이버",
    monthlyPrice: null,
  },
  {
    name: "S",
    keywords: 10,
    competitors: 3,
    cycle: "주 1회",
    channels: "네이버 + 구글",
    monthlyPrice: null,
  },
  {
    name: "M",
    keywords: 20,
    competitors: 5,
    cycle: "주 1회",
    channels: "전체 + AI 반입",
    monthlyPrice: null,
  },
  {
    name: "L",
    keywords: 40,
    competitors: 10,
    cycle: "주 2회",
    channels: "전체 · 다지점",
    monthlyPrice: null,
  },
] as const;
