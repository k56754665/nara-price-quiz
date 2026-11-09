const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g,'').toLowerCase();

// Matching thousands of saved rows against the entire plan on every click made
// the catalog refresh dominate review time. Index the possible families first.
const topicIndexes=new WeakMap();
const aliasIds=['F002','F004','F005','F029','F035','F046','F047','F053','F058','F059','F062','F081'];
export function matchingFamiliarTopics(topics,record) {
  let index=topicIndexes.get(topics);
  if(!index) {
    index=new Map();
    for(const topic of topics)for(const family of topic.families) {
      const key=compact(family),group=index.get(key)||[];
      group.push(topic);index.set(key,group);
    }
    index.aliases=topics.filter(topic=>aliasIds.includes(topic.id));
    topicIndexes.set(topics,index);
  }
  const family=compact((record.specification || record.prdctSpecNm || '').split(',')[0]);
  return [...new Set([...(index.get(family)||[]),...index.aliases])].filter(topic=>matchesFamiliarTopic(topic,record));
}

export function ratedPower(specification) {
  const match=compact(specification).match(/(?:^|,)(?:(\d+(?:\.\d+)?)[×x*])?(\d+(?:\.\d+)?)w(?:$|,)/);
  return match?Number(match[2])*Number(match[1]||1):null;
}

export function matchesFamiliarTopic(topic, record) {
  const specification = record.specification || record.prdctSpecNm || '';
  const text = compact(specification), family = compact(specification.split(',')[0]);
  if(topic.maxRatedPowerW) {
    const power=ratedPower(specification);
    if(power===null || power>topic.maxRatedPowerW)return false;
  }
  if (/(?:서비스|용역|임대|대여)$/.test(family)) return false;
  if (/(?:\(부품\)|\(부속품\)|교체용부품)/.test(text)) return false;
  if (topic.id === 'F003' && (!/보행/.test(text) || /바닥|신호등주|기둥|제어기/.test(text))) return false;
  if (topic.id === 'F004' && !/바닥/.test(text)) return false;
  if (topic.id === 'F035' && /배분대|배식대|운반|소독|세척|살균|건조|보관|수거대/.test(family)) return false;
  let familyMatch = topic.families.some(value => compact(value) === family);
  // Official product names sometimes differ from the everyday topic name.
  // Only explicit uses in the specification may bridge that difference.
  const aliases = {
    F002: [/버스.*정보.*안내|버스.*차량.*정보/, /버스정보|정류장|bis/],
    F004: [/교통신호등|보행신호등/, /바닥/],
    F005: [/차양|그늘막|파라솔/, /그늘막|횡단보도|스마트그늘/],
    F029: [/운동장및놀이터용흔들놀이기구/, /흔들놀이기구/],
    F035: [/^(식판|급식용식판|식탁용식기)$/, /식판/],
    F046: [/민원.*발급|민원.*처리/, /무인민원|민원발급/],
    F047: [/순번|번호표/, /발급|발행/],
    F053: [/음식물.*쓰레기.*처리|폐기물.*계량|종량/, /rfid|종량/],
    F058: [/주차관제|차량차단|주차차단/, /차량차단|주차차단|차단기/],
    F059: [/주차관제|정산/, /정산기/],
    F062: [/^(수동식소화기|분말소화기|축압식소화기)$/, /수동식|분말|축압/],
    F081: [/군용헬멧|전투용헬멧|방탄모|방탄헬멧/, /방탄/]
  };
  const alias = aliases[topic.id];
  if (alias && alias[0].test(family) && alias[1].test(text)) familyMatch = true;
  if (topic.id === 'F005' && ['㎡','m2','m²','m'].includes(compact(record.unit || record.prdctUnit))) return false;
  return familyMatch
    && (!topic.requiredAny || topic.requiredAny.some(word => text.includes(compact(word))))
    && (!topic.requiredAll || topic.requiredAll.every(word => text.includes(compact(word))))
    && (!topic.excludeAny || !topic.excludeAny.some(word => text.includes(compact(word))));
}

// One useful search from each scene before trying alternative terms/endpoints.
// These are narrow product-name queries, never a scan of all procurement goods.
export const FAMILIAR_SEARCHES = [
  ['F028','시소'], ['F002','버스및차량정보안내장치'], ['F046','무인민원발급기'],
  ['F043','농구대'], ['F058','차량차단기'], ['F035','식판'],
  ['F029','흔들놀이기구'], ['F062','소화기'], ['F081','방탄모'], ['F083','전투화'],
  ['F003','교통신호등'], ['F044','축구골대'], ['F047','순번대기시스템'],
  ['F005','파라솔'], ['F053','음식물쓰레기처리기'], ['F031','학생용책상'],
  ['F008','도로반사경'], ['F011','도로명판'], ['F073','구급차'], ['F004','바닥신호등']
];

export function familiarSearchPlan(plan) {
  const sources=[],seen=new Set(),topicIds=new Set(plan.topics.map(topic=>topic.id));
  const add=(id,term,operation,phase)=>{
    if(!term)return;
    const key=`${operation}:${term}`;
    if(seen.has(key))return;
    seen.add(key);sources.push({id,term,operation,key,phase});
  };
  const mas='getMASCntrctPrdctInfoList',thirdParty='getThptyUcntrctPrdctInfoList',unitContract='getUcntrctPrdctInfoList';
  // The original 20 queries remain useful starting points, never the entire plan.
  for(const [id,term] of FAMILIAR_SEARCHES)if(topicIds.has(id))add(id,term,mas,0);
  for(const topic of [...plan.topics].sort((a,b)=>(a.priority||2)-(b.priority||2)))add(topic.id,topic.keywords[0],mas,0);
  for(const topic of plan.topics)for(const term of topic.keywords.slice(1))add(topic.id,term,mas,2);
  // Goods can be registered under another contract type. A 0-row MAS lookup
  // does not prove that the product is absent from the shopping mall.
  const primary=[...sources].filter(s=>s.phase===0);
  // Check the other main contract type before spending calls on more guesses
  // for a MAS product name that already returned zero rows.
  for(const source of primary)add(source.id,source.term,thirdParty,1);
  for(const source of primary)add(source.id,source.term,unitContract,3);
  return sources;
}

export function discoveryQueryKey(operation,term,page=1) {
  const key=`${operation}:${term}`;
  return page===1?key:`${key}:page:${page}`;
}
