// 로컬 실측: npx tsx scripts/probe.ts "서울비디치과" "천안 임플란트" "불당동 치과" ...
// 첫 인자 = 우리 병원 이름, 나머지 = 키워드. 환경변수 PLACE_ID 가 있으면 플레이스 리뷰 수도 읽는다.
import { collectNaverSerp } from "../src/collectors/naver-serp";
import { collectNaverPlace } from "../src/collectors/naver-place";
import { rankScore, platformScore } from "../src/lib/scoring";

const [name, ...keywords] = process.argv.slice(2);
if (!name || !keywords.length) {
  console.error("usage: probe <hospitalName> <keyword...>");
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const self = {
  key: "self",
  name,
  aliases: (process.env.ALIASES || "").split(",").filter(Boolean),
  placeId: process.env.PLACE_ID || null,
};
const rows: {
  keyword: string;
  self: number;
  competitors: Record<string, number>;
}[] = [];
for (const kw of keywords) {
  const r = await collectNaverSerp(kw, [self]);
  const me = r.entities.self;
  const top = r.placeCards
    .filter((c) => !c.isAd)
    .slice(0, 5)
    .map((c) => `${c.position}.${c.name}`)
    .join(" / ");
  console.log(
    `[${kw}] blocked=${r.blocked} html=${r.htmlLength} sections=${Object.entries(
      r.sections,
    )
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(",")}`,
  );
  console.log(`   place top5: ${top}`);
  console.log(
    `   self: shown=${me.shown} placeRank=${me.placeRank} ad=${me.placeAd} mentions=${me.mentions} aib=${r.aiBriefingShown}/${me.aiBriefingMentioned} → score ${rankScore(me.placeRank, me.mentions > 0)}`,
  );
  rows.push({
    keyword: kw,
    self: rankScore(me.placeRank, me.mentions > 0),
    competitors: {},
  });
  await sleep(3000 + Math.random() * 4000);
}
console.log("naver_serp platform score:", platformScore(rows));
if (process.env.PLACE_ID)
  console.log("place snapshot:", await collectNaverPlace(process.env.PLACE_ID));
