begin;
-- 게임 규칙 v4: 매 게임 10문제(문제은행에서 무작위), 물건마다 최대 3번 추측.
-- 정답의 ±10% 안이면 성공이고, 몇 번째에 맞혔는지에 따라 점수를 줍니다.
--   1번째 1000 · 2번째 800 · 3번째 500 · 실패 0
-- (v3는 4번 추측 · 1000/800/600/500이었습니다. v3 함수와 기록은 그대로 둡니다.)
-- 점수를 바꾸면 dist/engine.js의 ATTEMPT_SCORES·TOLERANCE_PERCENT도 같이 바꿔야 합니다.
--
-- leaderboard.sql과 curated-release.sql을 먼저 적용해야 합니다(정답표 quiz_answers_v2 사용).
-- 기존 함수·정답·기록은 그대로 둡니다. 새 규칙 기록은 '<문제은행 버전>:r4' 랭킹에 따로 쌓입니다.
-- 다시 실행해도 안전합니다.

-- 배포 검사(scripts/verify-ranking.mjs)가 운영 DB에 이 규칙이 적용됐는지 확인할 때 씁니다.
create or replace function public.get_ranking_protocol()
returns int
language sql immutable set search_path = ''
as $$ select 4; $$;
revoke all on function public.get_ranking_protocol() from public;
grant execute on function public.get_ranking_protocol() to anon, authenticated;

create or replace function public.submit_score_v4(
  p_question_set text, p_time_limit int, p_client_id uuid, p_nickname text, p_attempts jsonb
)
returns table (rank bigint, total_score int, perfect_count int)
language plpgsql security definer set search_path = ''
as $$
declare
  c_rounds constant int := 10;
  c_max_attempts constant int := 3;
  c_tolerance_percent constant int := 10;
  c_scores constant int[] := array[1000, 800, 500];
  v_set text := p_question_set || ':r4';
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_total int := 0; v_correct_count int := 0;
  v_round jsonb; v_guesses jsonb; v_guess jsonb; v_value bigint; v_answer bigint;
  v_len int; v_index int; v_correct boolean; v_id bigint;
  v_seen text[] := array[]::text[]; v_question text;
begin
  if p_time_limit is null or p_time_limit <> 0 then raise exception 'invalid_mode'; end if;
  if p_client_id is null then raise exception 'invalid_client'; end if;
  if char_length(v_nickname) not between 1 and 12 or v_nickname ~ '[[:cntrl:]<>]' then raise exception 'invalid_nickname'; end if;
  if p_question_set is null or not exists (select 1 from public.quiz_answers_v2 where question_set = p_question_set) then raise exception 'unknown_question_set'; end if;
  if p_attempts is null or jsonb_typeof(p_attempts) <> 'array' or jsonb_array_length(p_attempts) <> c_rounds then raise exception 'invalid_attempts'; end if;

  for v_round in select value from jsonb_array_elements(p_attempts) loop
    if jsonb_typeof(v_round) <> 'object' or jsonb_typeof(v_round -> 'question_id') is distinct from 'string' then raise exception 'invalid_attempts'; end if;
    v_question := v_round ->> 'question_id';
    if v_question = any(v_seen) then raise exception 'invalid_attempts'; end if;
    v_seen := array_append(v_seen, v_question);
    select a.answer into v_answer from public.quiz_answers_v2 a where a.question_set = p_question_set and a.question_id = v_question;
    if not found then raise exception 'invalid_attempts'; end if;

    v_guesses := v_round -> 'attempts';
    if jsonb_typeof(v_guesses) is distinct from 'array' then raise exception 'invalid_attempts'; end if;
    v_len := jsonb_array_length(v_guesses);
    if v_len not between 1 and c_max_attempts then raise exception 'invalid_attempts'; end if;

    v_index := 0; v_correct := false;
    for v_guess in select value from jsonb_array_elements(v_guesses) loop
      v_index := v_index + 1;
      if jsonb_typeof(v_guess) <> 'number' or (v_guess #>> '{}') !~ '^[0-9]{1,12}$' then raise exception 'invalid_attempts'; end if;
      v_value := (v_guess #>> '{}')::bigint;
      if v_value not between 1 and 999999999999 then raise exception 'invalid_attempts'; end if;
      -- engine.js의 isCorrect와 같은 정수 비교
      v_correct := abs(v_value - v_answer) * 100 <= v_answer * c_tolerance_percent;
      -- 맞히면 그 라운드는 끝나므로, 마지막이 아닌 추측이 정답이면 잘못된 기록입니다.
      if v_correct and v_index < v_len then raise exception 'invalid_attempts'; end if;
    end loop;
    -- 틀린 채로 끝났다면 기회를 모두 쓴 경우여야 합니다.
    if not v_correct and v_len <> c_max_attempts then raise exception 'invalid_attempts'; end if;

    if v_correct then
      v_total := v_total + c_scores[v_len];
      v_correct_count := v_correct_count + 1;
    end if;
  end loop;

  insert into public.leaderboard_scores (question_set, time_limit, client_id, nickname, total_score, perfect_count, question_count, attempts)
  values (v_set, 0, p_client_id, v_nickname, v_total, v_correct_count, c_rounds, p_attempts)
  on conflict (question_set, time_limit, client_id) do nothing returning id into v_id;
  if v_id is null then raise exception 'already_submitted'; end if;

  return query select count(distinct s.client_id) + 1, v_total, v_correct_count from public.leaderboard_scores s
    where s.question_set = v_set and s.client_id <> p_client_id
    and (s.total_score > v_total or (s.total_score = v_total and s.perfect_count > v_correct_count));
end; $$;
revoke all on function public.submit_score_v4(text, int, uuid, text, jsonb) from public;
grant execute on function public.submit_score_v4(text, int, uuid, text, jsonb) to anon, authenticated;

commit;
