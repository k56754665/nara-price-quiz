export const MAX_DISCOVERY_REQUESTS=50;
export const COLLECTION_PRESETS=[
  {id:'standard',label:'기본 · 새 종류 20종 목표 / API 최대 30회',target:20,maxRequests:30},
  {id:'large',label:'많이 · 새 종류 30종 목표 / API 최대 50회',target:30,maxRequests:50},
  {id:'economy',label:'절약 · 새 종류 10종 목표 / API 최대 10회',target:10,maxRequests:10}
];
export function collectionPreset(id='standard') {
  const preset=COLLECTION_PRESETS.find(preset=>preset.id===id);
  if(!preset)throw Error('수집량을 기본·많이·절약 중에서 선택해 주세요.');
  return {...preset};
}
export function validateRequestLimit(limit) {
  if(!Number.isInteger(limit)||limit<0||limit>MAX_DISCOVERY_REQUESTS)throw Error(`수집당 API 요청은 최대 ${MAX_DISCOVERY_REQUESTS}회입니다.`);
}
