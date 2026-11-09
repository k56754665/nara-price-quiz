import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const API_BASE = 'https://apis.data.go.kr/1230000/at/ShoppingMallPrdctInfoService/';
export const OPERATIONS = ['getMASCntrctPrdctInfoList', 'getThptyUcntrctPrdctInfoList', 'getUcntrctPrdctInfoList'];
const fields = ['prdctIdntNo','prdctClsfcNo','prdctClsfcNoNm','dtilPrdctClsfcNo','prdctSpecNm','cntrctPrceAmt','prdctUnit','prdctDlvryCndtnNm','vatAplDivNm','cntrctCorpNm','prdctMakrNm','shopngCntrctNo','shopngCntrctSno','cntrctBgnDate','cntrctEndDate','prdctImgUrl','dscntAmt','dscntBgnDate','dscntEndDate','rgstDt','chgDt'];
const kstFormatter=new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit' });
export const kstDate = time => kstFormatter.format(new Date(time ?? Date.now()));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function loadServiceKey(root) {
  if (process.env.DATA_GO_KR_SERVICE_KEY) return process.env.DATA_GO_KR_SERVICE_KEY.trim();
  for (const file of [path.join(root,'.env.local'),path.join(root,'../.env.local')]) {
    let text; try { text = await readFile(file,'utf8'); } catch (error) { if(error.code==='ENOENT')continue; throw Error('로컬 API 설정 파일을 읽지 못했습니다.'); }
    const match = text.match(/^\s*DATA_GO_KR_SERVICE_KEY\s*=\s*(.*?)\s*$/m);
    if (match && !match[1].includes('여기에')) return match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  throw Error('공공데이터포털 인증키가 필요합니다. 로컬 .env.local의 DATA_GO_KR_SERVICE_KEY를 설정해 주세요.');
}

export function safeImageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'shop.g2b.go.kr' && !url.username && !url.password && !url.search && !url.hash ? url : null; } catch { return null; }
}

export async function readProductImage(url, fetchImpl = fetch) {
  if (!safeImageUrl(url)) throw Error('공식 상품 이미지 주소를 확인하지 못했습니다.');
  let response; try { response = await fetchImpl(url,{signal:AbortSignal.timeout(15000),redirect:'error'}); } catch { throw Error('상품 이미지를 내려받지 못했습니다.'); }
  if (!response.ok) throw Error(`상품 이미지 응답 오류 (${response.status})`);
  const chunks = []; let length = 0;
  for await (const part of response.body) { length += part.length; if(length>12_000_000)throw Error('상품 이미지가 너무 큽니다.'); chunks.push(Buffer.from(part)); }
  const bytes = Buffer.concat(chunks);
  const jpg = bytes[0]===0xff && bytes[1]===0xd8;
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!jpg && !png) throw Error('상품 이미지 형식을 확인하지 못했습니다.');
  return { bytes, extension:jpg?'.jpg':'.png', sha256:sha256(bytes) };
}

export function createProcurementApi({ serviceKey, fetchImpl = fetch, maxAttempts=2 } = {}) {
  if (!serviceKey) throw Error('공공데이터포털 인증키가 필요합니다.');
  if (![1,2].includes(maxAttempts)) throw Error('API 재시도 설정을 확인해 주세요.');
  // Accept either key format while URLSearchParams performs exactly one encoding.
  try { if (/%[0-9a-f]{2}/i.test(serviceKey)) serviceKey = decodeURIComponent(serviceKey); } catch { throw Error('인증키 형식을 확인해 주세요.'); }
  return {
    async query(operation, parameters = {}) {
      if (!OPERATIONS.includes(operation)) throw Error('지원하지 않는 품목 조회입니다.');
      const url = new URL(operation,API_BASE);
      for (const [key,value] of Object.entries({type:'json',pageNo:'1',numOfRows:'100',...parameters})) url.searchParams.set(key,String(value));
      url.searchParams.set('serviceKey',serviceKey);
      let response;
      for(let attempt=0;attempt<maxAttempts;attempt++) {
        try { response = await fetchImpl(url,{signal:AbortSignal.timeout(25000),redirect:'error'}); break; }
        catch { if(attempt===maxAttempts-1)throw Error('나라장터 API에 연결하지 못했습니다. 인터넷 연결 또는 인증키의 이용 상태를 확인해 주세요.'); }
      }
      if (!response.ok) throw Error(`나라장터 API 응답 오류 (${response.status})`);
      let raw; try { raw = await response.text(); } catch { throw Error('나라장터 API 응답을 읽지 못했습니다.'); }
      let data; try { data = JSON.parse(raw); } catch {
        if (/SERVICE_KEY|SERVICEKEY|AUTH|ACCESS|등록되지|인증키/i.test(raw)) throw Error('공공데이터포털 인증키의 등록·활용신청 상태를 확인해 주세요.');
        if (/LIMIT|QUOTA|제한|초과/i.test(raw)) throw Error('나라장터 API 호출 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
        throw Error('나라장터 API가 정상적인 품목 응답을 보내지 않았습니다.');
      }
      const header = data.response?.header;
      if (!['00','0','NORMAL_SERVICE'].includes(String(header?.resultCode))) {
        const code = String(header?.resultCode || 'unknown').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
        throw Error(`나라장터 API 조회에 실패했습니다 (코드 ${code}).`);
      }
      const body = data.response.body;
      if (!body || !Number.isFinite(Number(body.totalCount))) throw Error('나라장터 API의 목록 형식을 확인하지 못했습니다.');
      let items = body.items?.item ?? body.items ?? [];
      if (!Array.isArray(items)) items = items && typeof items==='object' && Object.keys(items).length ? [items] : [];
      // Do not persist API keys, officer names, phone numbers or email addresses.
      return { totalCount:Number(body.totalCount),pageSize:Number(body.numOfRows)||Number(parameters.numOfRows)||100,items:items.map(item=>Object.fromEntries(fields.filter(key=>item[key]!=null).map(key=>[key,String(item[key])]))),checkedAt:new Date().toISOString() };
    },
    image: url => readProductImage(url,fetchImpl),
  };
}
