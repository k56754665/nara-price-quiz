// 결과창 공유 버튼(카카오톡 공유 / 공유하기). Project-PHD 결과창과 같은 방식이다.
//
// - navigator.share 와 카카오 SDK 는 사용자 제스처 안에서 불려야 한다. 그래서 클릭 핸들러에서
//   await 없이 바로 부른다.
// - 카카오 SDK 는 결과창을 열 때 미리 불러둔다. 버튼을 누른 뒤에 로드하면 제스처와 시간이 벌어져
//   카카오 공유창이 팝업 차단에 걸릴 수 있다.

// Project-PHD 와 같은 카카오 앱의 JavaScript 키.
// 카카오 개발자 콘솔 [앱 설정 > 플랫폼 > Web] 에 이 게임의 origin 이 등록돼 있어야 동작한다.
//   배포: https://k56754665.github.io   로컬: http://127.0.0.1:4173 / http://localhost:4173
const KAKAO_JS_KEY = 'a85ba2768dfcf7e1636058cdc9c8c683';
const KAKAO_SDK_URL = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js';

const GAME_TITLE = '이게 얼마게? · 나라장터 가격 퀴즈';
const KAKAO_CHALLENGE = '너도 도전해볼래?';
// 공유 링크에는 쿼리/해시를 빼고 페이지 주소만 담는다.
const shareUrl = () => location.origin + location.pathname;

let kakaoReady = false;
let kakaoLoading = false;

export function loadKakao() {
  if (!KAKAO_JS_KEY || kakaoReady || kakaoLoading) return;
  kakaoLoading = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = KAKAO_SDK_URL;
  script.onload = () => {
    try {
      if (window.Kakao) {
        if (!window.Kakao.isInitialized()) window.Kakao.init(KAKAO_JS_KEY);
        kakaoReady = true;
      }
    } catch (e) { console.warn('[share] 카카오 초기화 실패:', e); }
  };
  script.onerror = () => { kakaoLoading = false; console.warn('[share] 카카오 SDK 를 불러오지 못했습니다.'); };
  document.head.appendChild(script);
}

const fmt = n => Math.round(n || 0).toLocaleString('ko-KR');

// 라운드별 점수를 한 줄 블록으로. 워들처럼 대화창에 붙였을 때 눈에 띈다.
export function scoreBlocks(rounds) {
  return rounds.map(({ score }) => score === 1000 ? '🟩' : score >= 850 ? '🟦' : score >= 600 ? '🟨' : score >= 300 ? '🟧' : '🟥').join('');
}

// { total, title, rounds, best, newBest }
export function buildShareText(result, withUrl = true) {
  const lines = [
    GAME_TITLE,
    scoreBlocks(result.rounds),
    `${fmt(result.total)} / 10,000점 · ${result.title}`,
    result.newBest ? '신기록! 🏆' : `최고 기록 ${fmt(result.best)}점`,
  ];
  if (withUrl) lines.push(`▶ ${shareUrl()}`);
  return lines.join('\n');
}

// notify(message) 로 토스트를 띄운다.
export function shareKakao(result, notify) {
  // SDK 2.x 는 Kakao.Share, 그 이전 버전은 Kakao.Link 였다.
  const api = window.Kakao && (window.Kakao.Share || window.Kakao.Link);
  if (!kakaoReady || !api) { loadKakao(); notify('카카오톡 공유를 쓸 수 없어요. 잠시 후 다시 눌러 주세요.'); return; }
  const url = shareUrl();
  try {
    api.sendDefault({
      objectType: 'text',
      text: `${buildShareText(result, false)}\n${KAKAO_CHALLENGE}`,
      link: { mobileWebUrl: url, webUrl: url },
      buttonTitle: '나도 도전하기',
    });
  } catch (e) {
    console.warn('[share] 카카오 공유 실패:', e);
    notify('공유에 실패했어요');
  }
}

// 시스템 공유 시트. 지원하지 않는 브라우저(대부분의 데스크톱)는 onUnsupported 로 넘긴다(결과 복사).
export function shareSystem(result, notify, onUnsupported) {
  if (!navigator.share) { onUnsupported(); return; }
  navigator.share({ title: GAME_TITLE, text: buildShareText(result, false), url: shareUrl() })
    .catch(e => {
      // 공유 시트를 그냥 닫은 경우(AbortError)는 실패가 아니다.
      if (e && e.name !== 'AbortError') notify('공유에 실패했어요');
    });
}
