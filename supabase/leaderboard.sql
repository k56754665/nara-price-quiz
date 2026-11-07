-- 이게 얼마게? 온라인 랭킹
-- Supabase 대시보드 → SQL Editor에 전체를 붙여 넣고 한 번 실행합니다. 다시 실행해도 안전합니다.
--
-- 보안 구조
-- - 테이블은 RLS를 켜고 정책을 두지 않아 브라우저(anon 키)에서 직접 읽고 쓸 수 없습니다.
-- - 브라우저는 submit_score / get_leaderboard 두 함수만 호출할 수 있습니다.
-- - 점수는 브라우저가 보낸 값을 믿지 않고, 추측값으로 서버에서 다시 계산합니다.
-- - 같은 기기(client_id)는 문제 세트·모드별로 한 번만 등록할 수 있습니다.

create table if not exists public.quiz_answers (
  question_set text not null,
  position int not null check (position between 1 and 10),
  question_id text not null,
  answer bigint not null check (answer > 0),
  primary key (question_set, position)
);

-- 정답은 dist/data.json과 같아야 합니다 (tests/leaderboard.test.mjs가 검사).
insert into public.quiz_answers (question_set, position, question_id, answer) values
  ('2026-11-03', 1, 'C01', 425000),
  ('2026-11-03', 2, 'C22', 20000),
  ('2026-11-03', 3, 'C26', 1290000),
  ('2026-11-03', 4, 'C04', 12900000),
  ('2026-11-03', 5, 'C13', 33000),
  ('2026-11-03', 6, 'C27', 48000000),
  ('2026-11-03', 7, 'C29', 423000),
  ('2026-11-03', 8, 'C03', 91300000),
  ('2026-11-03', 9, 'C06', 98370000),
  ('2026-11-03', 10, 'C28', 951500000)
on conflict (question_set, position) do update
  set question_id = excluded.question_id, answer = excluded.answer;

create table if not exists public.leaderboard_scores (
  id bigint generated always as identity primary key,
  question_set text not null,
  time_limit int not null check (time_limit in (0, 45)),
  client_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 12),
  total_score int not null check (total_score between 0 and 10000),
  perfect_count int not null check (perfect_count between 0 and 10),
  attempts jsonb not null,
  created_at timestamptz not null default now(),
  unique (question_set, time_limit, client_id)
);

create index if not exists leaderboard_scores_rank_idx
  on public.leaderboard_scores (question_set, time_limit, total_score desc, perfect_count desc, created_at);

alter table public.quiz_answers enable row level security;
alter table public.leaderboard_scores enable row level security;
revoke all on public.quiz_answers from anon, authenticated;
revoke all on public.leaderboard_scores from anon, authenticated;

-- engine.js의 scoreGuess와 같은 계산식
create or replace function public.leaderboard_score_guess(p_guess bigint, p_answer bigint)
returns int
language sql
immutable
set search_path = ''
as $$
  select case
    when p_guess is null or p_guess <= 0 then 0
    when p_guess = p_answer then 1000
    else least(999, round((1000 * exp(-1.5 * abs(ln(p_guess::double precision / p_answer))))::numeric)::int)
  end;
$$;

create or replace function public.submit_score(
  p_question_set text,
  p_time_limit int,
  p_client_id uuid,
  p_nickname text,
  p_attempts jsonb
)
returns table (rank bigint, total_score int, perfect_count int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_total int := 0;
  v_perfect int := 0;
  v_round jsonb;
  v_guess jsonb;
  v_last bigint;
  v_answer bigint;
  v_count int;
  v_id bigint;
begin
  if p_time_limit is null or p_time_limit not in (0, 45) then
    raise exception 'invalid_mode';
  end if;
  if p_client_id is null then
    raise exception 'invalid_client';
  end if;
  if char_length(v_nickname) not between 1 and 12 or v_nickname ~ '[[:cntrl:]<>]' then
    raise exception 'invalid_nickname';
  end if;

  select count(*) into v_count from public.quiz_answers where question_set = p_question_set;
  if v_count <> 10 then
    raise exception 'unknown_question_set';
  end if;

  if jsonb_typeof(p_attempts) <> 'array' or jsonb_array_length(p_attempts) <> 10 then
    raise exception 'invalid_attempts';
  end if;

  for i in 1..10 loop
    select a.answer into v_answer from public.quiz_answers a
      where a.question_set = p_question_set and a.position = i;
    v_round := p_attempts -> (i - 1);
    if jsonb_typeof(v_round) <> 'array' or jsonb_array_length(v_round) not between 1 and 2 then
      raise exception 'invalid_attempts';
    end if;

    v_last := null;
    for j in 0..jsonb_array_length(v_round) - 1 loop
      v_guess := v_round -> j;
      if jsonb_typeof(v_guess) = 'null' then
        -- 시간초과는 45초 모드에서만 나올 수 있습니다.
        if p_time_limit = 0 then raise exception 'invalid_attempts'; end if;
        v_last := null;
      elsif jsonb_typeof(v_guess) = 'number'
        and (v_guess #>> '{}') ~ '^[0-9]{1,12}$'
        and (v_guess #>> '{}')::bigint between 1 and 999999999999 then
        v_last := (v_guess #>> '{}')::bigint;
      else
        raise exception 'invalid_attempts';
      end if;
    end loop;

    -- 첫 추측이 정답일 때만 한 번으로 끝납니다.
    if (jsonb_array_length(v_round) = 1)
       <> (jsonb_typeof(v_round -> 0) = 'number' and (v_round ->> 0)::bigint = v_answer) then
      raise exception 'invalid_attempts';
    end if;

    v_total := v_total + public.leaderboard_score_guess(v_last, v_answer);
    if v_last = v_answer then v_perfect := v_perfect + 1; end if;
  end loop;

  insert into public.leaderboard_scores (question_set, time_limit, client_id, nickname, total_score, perfect_count, attempts)
  values (p_question_set, p_time_limit, p_client_id, v_nickname, v_total, v_perfect, p_attempts)
  on conflict (question_set, time_limit, client_id) do nothing
  returning id into v_id;

  if v_id is null then
    raise exception 'already_submitted';
  end if;

  return query
    select count(*) + 1, v_total, v_perfect
    from public.leaderboard_scores s
    where s.question_set = p_question_set and s.time_limit = p_time_limit
      and (s.total_score > v_total or (s.total_score = v_total and s.perfect_count > v_perfect));
end;
$$;

create or replace function public.get_leaderboard(p_question_set text, p_time_limit int, p_limit int default 20)
returns table (rank bigint, nickname text, total_score int, perfect_count int, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select rank() over (order by s.total_score desc, s.perfect_count desc),
         s.nickname, s.total_score, s.perfect_count, s.created_at
  from public.leaderboard_scores s
  where s.question_set = p_question_set and s.time_limit = p_time_limit
  order by s.total_score desc, s.perfect_count desc, s.created_at
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.leaderboard_score_guess(bigint, bigint) from public;
revoke all on function public.submit_score(text, int, uuid, text, jsonb) from public;
revoke all on function public.get_leaderboard(text, int, int) from public;
grant execute on function public.submit_score(text, int, uuid, text, jsonb) to anon, authenticated;
grant execute on function public.get_leaderboard(text, int, int) to anon, authenticated;
