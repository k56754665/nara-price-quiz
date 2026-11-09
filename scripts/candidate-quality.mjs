import { kstDate } from './procurement-api.mjs';

// This is a review priority from the saved procurement evidence, not a claim
// about market value. An official API response alone does not validate a price.
export function candidateQuality(candidate,comparison,{now=Date.now()}={}) {
  const reasons=[];
  const componentMismatch=/\(부품\)|\(부속품\)|교체용부품/.test(candidate.specification||'')&&!/부품|부속품|보관함|함체/.test(candidate.title||'');
  if(componentMismatch)reasons.push('부품 상품을 완제품 이름으로 표시 · 물건 이름과 출제 단위 확인');
  const fresh=candidate.freshness?.status==='verified' && Number.isFinite(Date.parse(candidate.checkedAt))
    && now-Date.parse(candidate.checkedAt)<=86400000 && now-Date.parse(candidate.checkedAt)>=-60000;
  if(!fresh)reasons.push('계약 정보의 최신 확인 필요');
  if(candidate.contractStart>kstDate(now)||candidate.contractEnd<kstDate(now))reasons.push('계약기간 확인 필요');
  if(comparison?.scopeMismatch)reasons.push('현재 상품이 이번 출제 범위와 다름');
  if(!comparison || comparison.insufficient)reasons.push('같은 조건의 비교 제조사 3곳 미만');
  if(comparison?.outlier)reasons.push('비교 중앙값의 1.75배 이상 · 가격·규격 재확인');
  if(comparison?.lowOutlier)reasons.push('비교 중앙값의 1/1.75 미만 · 부품·수량 재확인');
  if(comparison?.wideSpread)reasons.push('비교 가격 차이 3배 초과 · 세부 규격 재확인');
  if(comparison?.topicPriceConcern)reasons.push('같은 종류 전체의 가격대와 4배 이상 차이 · 특수 규격 여부 확인');
  if(comparison?.options.some(option=>!option.isFresh))reasons.push('비교 자료의 최신 확인 필요');
  if(!candidate.image?.sha256 || /image_non|placeholder/.test(candidate.image?.sourceUrl||''))reasons.push('실물 사진 확인 필요');
  if(!candidate.eligible && !candidate.pricePolicy?.contractPriceVerified)reasons.push('출제 기준 확인 필요');
  if(!['개','대','기','점','매','장','켤레','벌','본','좌','면'].includes(candidate.unit))reasons.push('묶음·면적·세트 단위 확인 필요');
  const requiresNote=Boolean(componentMismatch||comparison?.scopeMismatch||comparison?.outlier||comparison?.lowOutlier||comparison?.wideSpread||comparison?.topicPriceConcern);
  return {ready:reasons.length===0,requiresNote,reasons,
    score:Math.max(0,100-reasons.length*18)+(candidate.discoveryScore||0)/100,
    label:reasons.length?'확인 필요':'먼저 볼 후보'};
}

export function assertApprovalQuality(candidate,comparison,note) {
  const quality=candidateQuality(candidate,comparison);
  if(quality.requiresNote && !note?.trim())throw Error(`${candidate.title}: ${quality.reasons.join(' / ')}. 규격·출처·검토 메모에 확인 근거를 남긴 뒤 승인해 주세요.`);
}
