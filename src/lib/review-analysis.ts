// 리뷰 본문 규칙 분석 — 진료 키워드·불만 키워드. LLM 없음.
import { PROCEDURES } from "../data/procedures";
export const COMPLAINT_TERMS = ["불친절", "대기", "기다", "오래 걸", "비싸", "비용이", "과잉", "실망", "아프", "통증", "재수술", "다시 해", "불만", "설명이 없", "설명 부족", "무성의", "강요", "권유", "예약이 안", "전화를 안", "불안", "후회", "최악", "화가", "짜증", "엉망", "잘못"];
export const TREATMENT_ALIASES: Record<string, string[]> = {
  임플란트: ["임플", "implant"], 치아교정: ["교정", "브라켓", "인비절라인", "투명교정"], 소아치과: ["아이", "아기", "어린이", "소아", "우리 애", "유치"], 라미네이트: ["라미", "앞니"], 충치치료: ["충치", "레진", "인레이"], 신경치료: ["신경"], 사랑니: ["사랑니", "발치"], 치아미백: ["미백"], 잇몸치료: ["잇몸", "치주"], 스케일링: ["스케일링", "치석"], 틀니: ["틀니"],
};
export function analyzeReview(body: string, clinicType: string | null): { treatments: string[]; complaints: string[] } {
  const t = body.replace(/\s+/g, " ");
  const list = (clinicType && PROCEDURES[clinicType]) || PROCEDURES["치과"];
  const treatments = list.filter((p) => t.includes(p) || (TREATMENT_ALIASES[p] || []).some((a) => t.includes(a)));
  const complaints = COMPLAINT_TERMS.filter((c) => t.includes(c));
  return { treatments, complaints };
}
export function isNegative(rating: number | null, complaints: string[]): boolean {
  if (rating != null) return rating <= 2;
  return complaints.length >= 2;
}
