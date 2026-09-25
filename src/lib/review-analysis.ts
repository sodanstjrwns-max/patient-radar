// 리뷰 본문 규칙 분석 — 진료 키워드·불만 키워드. LLM 없음.
import { PROCEDURES } from "../data/procedures";
// 불만 표현: 라벨 + 정규식. 증상 서술("어금니가 아프다고 해서")은 불만이 아니므로 아픔은 치료 과정 표현만 잡는다.
export const COMPLAINT_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "불친절", re: /불친절|퉁명|무뚝뚝|불쾌/ },
  { label: "대기", re: /대기(가|는|시간이)?\s?(길|오래|너무)|오래\s?기다|한참\s?기다|기다리(는|게)\s?(게|시간이)?\s?(길|오래|너무)/ },
  { label: "비용", re: /비싸|비용이\s?(너무|많이|부담)|바가지|가격이\s?(너무|세)/ },
  { label: "과잉진료", re: /과잉/ },
  { label: "실망", re: /실망|후회|최악|엉망|화가\s?나|짜증|다신\s?안|다시는\s?안|추천\s?안/ },
  { label: "통증", re: /너무\s?아프|아프게\s?(치료|하|해)|아팠(어요|습니다|고)|통증이\s?(심|너무|계속)/ },
  { label: "재치료", re: /재수술|다시\s?(해|치료)야|또\s?문제|재발/ },
  { label: "설명부족", re: /설명(이|을|도)?\s?(없|부족|안\s?해|제대로)|무성의|대충/ },
  { label: "강요", re: /강요|권유(가|를)\s?(너무|심)|영업/ },
  { label: "예약·연락", re: /예약(이|을)?\s?(안|어렵|힘들)|전화(를|도)?\s?(안\s?받|연결이\s?안)/ },
];
export const COMPLAINT_TERMS = COMPLAINT_PATTERNS.map((p) => p.label);
export const TREATMENT_ALIASES: Record<string, string[]> = {
  임플란트: ["임플", "implant"], 치아교정: ["교정", "브라켓", "인비절라인", "투명교정"], 소아치과: ["아이", "아기", "어린이", "소아", "우리 애", "유치"], 라미네이트: ["라미", "앞니"], 충치치료: ["충치", "레진", "인레이"], 신경치료: ["신경"], 사랑니: ["사랑니", "발치"], 치아미백: ["미백"], 잇몸치료: ["잇몸", "치주"], 스케일링: ["스케일링", "치석"], 틀니: ["틀니"],
};
/** 부정어가 붙은 경우("안 아프게", "기다리지 않고", "강요하지 않", "과잉진료 없이")는 불만으로 세지 않는다 */
export function hasComplaint(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
    const negated = /(안|않|없이|전혀|절대)\s?$/.test(before) || /^.{0,4}?(지\s?않|지도\s?않|하지\s?않|없이|없어서\s?좋|없었)/.test(after);
    if (!negated) return true;
  }
  return false;
}
export function analyzeReview(body: string, clinicType: string | null): { treatments: string[]; complaints: string[] } {
  const t = body.replace(/\s+/g, " ");
  const list = (clinicType && PROCEDURES[clinicType]) || PROCEDURES["치과"];
  const treatments = list.filter((p) => t.includes(p) || (TREATMENT_ALIASES[p] || []).some((a) => t.includes(a)));
  const complaints = COMPLAINT_PATTERNS.filter((p) => hasComplaint(t, p.re)).map((p) => p.label);
  return { treatments, complaints };
}
export function isNegative(rating: number | null, complaints: string[]): boolean {
  if (rating != null) return rating <= 2;
  return complaints.length >= 2;
}
