import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadCatalog, writeJSON } from './curation.mjs';
import { readProductImage, sha256 } from './procurement-api.mjs';
import { comparisonContext } from './product-comparison.mjs';
import { familiarCandidate } from './familiar-collection.mjs';

export async function chooseComparisonCandidate(root,{id,productId,revision},{imageReader=readProductImage}={}) {
  const {catalog,review}=await loadCatalog(root);
  if(review.revision!==revision)throw Error('선택 내용이 바뀌었습니다. 새로고침 후 다시 선택해 주세요.');
  const current=catalog.candidates.find(c=>c.id===id);
  if(!current || review.decisions[id]?.status!=='unreviewed')throw Error('미검토 후보에서만 대표를 바꿀 수 있습니다. 승인·보류·제외 결정은 먼저 직접 변경해 주세요.');
  const context=await comparisonContext(root,catalog,review),comparison=context.forCandidate(current);
  const option=comparison?.options.find(o=>o.productId===productId);
  if(!option)throw Error('동일 조건의 비교 후보에서 상품을 선택해 주세요.');
  if(!option.isFresh)throw Error('저장된 비교 자료의 최신 확인이 필요합니다. 이번 선택에서는 API를 자동 호출하지 않았습니다.');
  if(productId===current.productId)return {id:current.id,unchanged:true};
  const existing=catalog.candidates.find(c=>c.productId===productId);
  if(existing && ['approved','excluded'].includes(review.decisions[existing.id]?.status))throw Error('이미 승인하거나 제외한 상품의 상태는 자동으로 바꾸지 않습니다.');
  let image=existing?.image;
  if(image && image.sourceUrl===option.imageUrl) {
    try {if(sha256(await readFile(path.join(root,'content/images',path.basename(image.src))))!==image.sha256)image=null;}
    catch {image=null;}
  } else image=null;
  if(!image) {
    // Fetch only the official picture chosen by the human; no price API query.
    const result=await imageReader(option.imageUrl),filename=`P${productId}-${result.sha256.slice(0,12)}${result.extension}`;
    await mkdir(path.join(root,'content/images'),{recursive:true});
    await writeFile(path.join(root,'content/images',filename),result.bytes);
    image={src:`./assets/products/${filename}`,alt:`${current.title} — ${option.specification}`,sourceUrl:option.imageUrl,
      sourceLabel:'나라장터 등록 상품 이미지',kind:'catalog-image',retrievedAt:new Date().toISOString(),sha256:result.sha256};
  }
  const topic=context.plan.topics.find(t=>t.id===current.discoveryTopicId);
  const next={...familiarCandidate(option.entry,topic,current.category,image,'human-comparison-choice'),id:existing?.id || `P${productId}`,comparisonBaseline:current.comparisonBaseline || comparison.baselineEntry};
  const newCatalog={...catalog,candidates:catalog.candidates.map(c=>c.id===id?{...c,selectionSupersededBy:next.id}:c.id===existing?.id?next:c)};
  if(!existing)newCatalog.candidates.push(next);
  const newReview={...review,revision:review.revision+1,decisions:{...review.decisions,
    [id]:{...review.decisions[id],status:'held'},[next.id]:{status:'unreviewed',note:existing?review.decisions[existing.id]?.note || '':''}}};
  await writeJSON(path.join(root,'.artifacts/source-backups',`comparison-${Date.now()}.json`),{catalog,review});
  await writeJSON(path.join(root,'content/candidates.json'),newCatalog);
  try {await writeJSON(path.join(root,'content/review.json'),newReview);}
  catch(error){await writeJSON(path.join(root,'content/candidates.json'),catalog);throw error;}
  return {id:next.id,previousId:id,apiRequests:0};
}
