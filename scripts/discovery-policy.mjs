// A family describes what an object does, not its maker, model, colour or size.
// Product IDs still identify contract rows; families only control discovery.
const clean = value => String(value || '').normalize('NFKC').trim();
const aliases = [
  [/심장충격기|제세동기/,'심장충격기'],[/옥외용벤치|공원벤치|^벤치$/,'공원벤치'],
  [/퍼걸러|파고라/,'퍼걸러'],[/이동식화장실/,'이동식화장실'],
  [/전시용방독면|가스마스크|방독면/,'방독면'],[/군용사물함|^사물함$/,'사물함'],
  [/삼차원프린터|3d프린터|적층조형기/i,'3D프린터'],[/무인비행|무인항공|드론/,'드론'],
  [/보안용카메라|폐쇄회로카메라|cctv/i,'보안카메라'],
  [/경비.*로봇|감시.*로봇|순찰.*로봇/,'경비로봇'],[/감성.*로봇|교감.*로봇|반려.*로봇/,'교감로봇'],
  [/전자현미경/,'전자현미경'],[/현미경/,'광학현미경'],[/실물모형/,'실물모형'],
];
export function familyOf(record) {
  const specification=record.specification || record.prdctSpecNm || '';
  const pieces=specification.split(',').map(clean);
  let name=pieces[0] || record.classification?.name || record.prdctClsfcNoNm || record.title || '';
  name=clean(name).replace(/^기타\s*/,'').replace(/\s+/g,'');
  for(const [pattern,label] of aliases)if(pattern.test(name)){name=label;break;}
  let use='';
  // Only explicit use descriptions after maker/model are considered. Numeric
  // model codes and dimensions must never manufacture a new family.
  if(/로봇|드론|장갑|특수목적차량|시뮬레이터/.test(name)) {
    const description=pieces.slice(3).join(' ');
    for(const [pattern,label] of [[/수중/,'수중'],[/폭발물/,'폭발물처리'],[/인명구조|구조용/,'인명구조'],[/방역|소독/,'방역'],[/농업|농사용/,'농업'],[/음식운반|급식운반/,'음식운반'],[/안내용/,'안내'],[/절연/,'절연'],[/방검/,'방검'],[/방열/,'방열'],[/군전투|전투용/,'전투']])if(pattern.test(description)){use=label;break;}
  }
  const label=name+(use?` · ${use}`:'');
  return {key:'kind:'+label.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),label};
}

export function familiesFor(catalog,review) {
  const families={...(review.seenFamilies || {})};
  for(const c of catalog.candidates) {
    const family=familyOf(c);
    if(family.label)families[family.key] ||= {label:family.label,exampleProductId:c.productId};
  }
  return families;
}

export function interestScore(row) {
  const name=familyOf(row).label;
  if(/(?:서비스|용역|임대|대여|수수료|이용권)$/.test(name))return -100;
  let score=0;
  for(const pattern of [/로봇|무인|드론/,/천체|망원경|현미경|투영/,/수중|잠수|수상|선박/,/훈련|모형|시뮬레이터/,/탐지|방사선|분석|측정/,/멸균|배양|동결|원심/,/농업|종자|양봉|사료|착유/])if(pattern.test(name))score+=15;
  if(/복사용지|토너|잉크|케이블|볼트|너트|나사|배관|타일|프린터용지/.test(name))score-=80;
  score+=Math.min(6,Math.max(0,Math.log10(Number(row.cntrctPrceAmt)||1)-4));
  return score;
}

// Search across uses rather than replenishing the same park furniture models.
const topics=[
  ['로봇·미래기술',['로봇','무인','드론','3D프린터','삼차원프린터','가상현실','시뮬레이터']],
  ['우주·과학·실험',['망원경','천체','현미경','투영기','원심분리기','분광','분석기','기상관측','지진','진동시험','재료시험','배양기','동결건조']],
  ['소방·구조·탐지',['구조','소방','방사선','탐지기','열화상','공기호흡기','제독','구난','누수탐지','가스측정','방폭']],
  ['바다·수중·환경',['수중','잠수','선박','보트','수상','유량계','수질','파쇄기','압축기','정화','분진','해양']],
  ['농업·동물·식품',['농업','파종','종자','이앙기','수확기','착유','양봉','부화기','사료','식물재배','초음파','멸균기']],
  ['교육·체험·문화',['모형','훈련','체험','악기','피아노','타악기','발사기','점자','도서자동화','무대','프로젝터']],
  ['특수차량·산업장비',['제설','살포','견인','고소작업','굴착','인양','지게차','용접','절단기','진공','수소','충전장치']],
];
export const NOVELTY_SOURCES=[];
for(let i=0;i<Math.max(...topics.map(([,terms])=>terms.length));i++)for(const [category,terms] of topics) {
  const term=terms[i];if(!term)continue;
  for(const operation of ['getMASCntrctPrdctInfoList','getThptyUcntrctPrdctInfoList'])NOVELTY_SOURCES.push({category,term,operation,key:`${operation}:${term}`});
}
