// Supabase 프로젝트의 Project URL과 anon(public) 키를 넣으면 온라인 랭킹이 켜집니다.
// anon 키는 브라우저에 공개되도록 만들어진 키라서 저장소에 올려도 됩니다.
// service_role 키는 절대 넣지 마세요.
// 비워 두면 랭킹 UI가 숨겨지고 게임은 그대로 동작합니다.
export const LEADERBOARD_CONFIG = {
  url: '',
  anonKey: '',
};
