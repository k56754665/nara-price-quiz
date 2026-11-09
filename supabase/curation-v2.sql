-- Existing leaderboard.sql must already be installed. Adds random-bank support;
-- keeps the original answers, RPCs and leaderboard rows for old clients/sessions.
create table if not exists public.quiz_answers_v2 (
  question_set text not null,
  question_id text not null,
  answer bigint not null check (answer > 0),
  primary key (question_set, question_id)
);
alter table public.quiz_answers_v2 enable row level security;
revoke all on public.quiz_answers_v2 from anon, authenticated;

create or replace function public.get_quiz_bank_status(p_question_set text)
returns table (question_count bigint, answer_fingerprint text)
language sql stable security definer set search_path = ''
as $$ select count(*), md5(coalesce(string_agg(question_id || ':' || answer::text, ',' order by question_id), '')) from public.quiz_answers_v2 where question_set = p_question_set; $$;
revoke all on function public.get_quiz_bank_status(text) from public;
grant execute on function public.get_quiz_bank_status(text) to anon, authenticated;

create or replace function public.submit_score_v2(
  p_question_set text, p_time_limit int, p_client_id uuid, p_nickname text, p_attempts jsonb
)
returns table (rank bigint, total_score int, perfect_count int)
language plpgsql security definer set search_path = ''
as $$
declare
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_total int := 0; v_perfect int := 0; v_round jsonb; v_guesses jsonb;
  v_guess jsonb; v_last bigint; v_answer bigint; v_rounds int; v_id bigint;
  v_seen text[] := array[]::text[]; v_question text;
begin
  if p_time_limit is null or p_time_limit <> 0 then raise exception 'invalid_mode'; end if;
  if p_client_id is null then raise exception 'invalid_client'; end if;
  if char_length(v_nickname) not between 1 and 12 or v_nickname ~ '[[:cntrl:]<>]' then raise exception 'invalid_nickname'; end if;
  if not exists (select 1 from public.quiz_answers_v2 where question_set = p_question_set) then raise exception 'unknown_question_set'; end if;
  if p_attempts is null or jsonb_typeof(p_attempts) <> 'array' then raise exception 'invalid_attempts'; end if;
  v_rounds := jsonb_array_length(p_attempts);
  if v_rounds not in (3,5,10,15,20,30,40,50) then raise exception 'invalid_attempts'; end if;
  for v_round in select value from jsonb_array_elements(p_attempts) loop
    if jsonb_typeof(v_round) <> 'object' or jsonb_typeof(v_round -> 'question_id') is distinct from 'string' then raise exception 'invalid_attempts'; end if;
    v_question := v_round ->> 'question_id';
    if v_question = any(v_seen) then raise exception 'invalid_attempts'; end if;
    v_seen := array_append(v_seen, v_question);
    select a.answer into v_answer from public.quiz_answers_v2 a where a.question_set = p_question_set and a.question_id = v_question;
    if not found then raise exception 'invalid_attempts'; end if;
    v_guesses := v_round -> 'attempts';
    if jsonb_typeof(v_guesses) is distinct from 'array' then raise exception 'invalid_attempts'; end if;
    if jsonb_array_length(v_guesses) not between 1 and 2 then raise exception 'invalid_attempts'; end if;
    v_last := null;
    for v_guess in select value from jsonb_array_elements(v_guesses) loop
      if jsonb_typeof(v_guess) <> 'number' then raise exception 'invalid_attempts'; end if;
      if (v_guess #>> '{}') !~ '^[0-9]{1,12}$' then raise exception 'invalid_attempts'; end if;
      v_last := (v_guess #>> '{}')::bigint;
      if v_last not between 1 and 999999999999 then raise exception 'invalid_attempts'; end if;
    end loop;
    if (jsonb_array_length(v_guesses) = 1) <> ((v_guesses ->> 0)::bigint = v_answer) then raise exception 'invalid_attempts'; end if;
    v_total := v_total + public.leaderboard_score_guess(v_last, v_answer);
    if v_last = v_answer then v_perfect := v_perfect + 1; end if;
  end loop;
  insert into public.leaderboard_scores (question_set,time_limit,client_id,nickname,total_score,perfect_count,question_count,attempts)
  values (p_question_set,0,p_client_id,v_nickname,v_total,v_perfect,v_rounds,p_attempts)
  on conflict (question_set,time_limit,client_id) do nothing returning id into v_id;
  if v_id is null then raise exception 'already_submitted'; end if;
  return query select count(distinct s.client_id) + 1, v_total, v_perfect from public.leaderboard_scores s
    where s.question_set = p_question_set and s.client_id <> p_client_id
    and (s.total_score > v_total or (s.total_score = v_total and s.perfect_count > v_perfect));
end; $$;
revoke all on function public.submit_score_v2(text,int,uuid,text,jsonb) from public;
grant execute on function public.submit_score_v2(text,int,uuid,text,jsonb) to anon, authenticated;
