begin;
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

-- Generated from the approved bank. Do not edit answers by hand.
insert into public.quiz_answers_v2 (question_set, question_id, answer) values
  ('curated-f65a6b9c11379a53', 'C01', 425000),
  ('curated-f65a6b9c11379a53', 'C02', 12300000),
  ('curated-f65a6b9c11379a53', 'C03', 91300000),
  ('curated-f65a6b9c11379a53', 'C04', 12900000),
  ('curated-f65a6b9c11379a53', 'C05', 10500000),
  ('curated-f65a6b9c11379a53', 'C06', 98370000),
  ('curated-f65a6b9c11379a53', 'C07', 5705000),
  ('curated-f65a6b9c11379a53', 'C08', 90000000),
  ('curated-f65a6b9c11379a53', 'C10', 7500000),
  ('curated-f65a6b9c11379a53', 'C11', 1540000),
  ('curated-f65a6b9c11379a53', 'C12', 188000),
  ('curated-f65a6b9c11379a53', 'C13', 33000),
  ('curated-f65a6b9c11379a53', 'C14', 7335000),
  ('curated-f65a6b9c11379a53', 'C16', 3432000),
  ('curated-f65a6b9c11379a53', 'C17', 3885000),
  ('curated-f65a6b9c11379a53', 'C18', 27075000),
  ('curated-f65a6b9c11379a53', 'C21', 148500),
  ('curated-f65a6b9c11379a53', 'C22', 20000),
  ('curated-f65a6b9c11379a53', 'C23', 18800),
  ('curated-f65a6b9c11379a53', 'C25', 422000),
  ('curated-f65a6b9c11379a53', 'C28', 951500000),
  ('curated-f65a6b9c11379a53', 'C29', 423000),
  ('curated-f65a6b9c11379a53', 'P25638725', 220000),
  ('curated-f65a6b9c11379a53', 'P25277943', 20500000),
  ('curated-f65a6b9c11379a53', 'P23979543', 130000),
  ('curated-f65a6b9c11379a53', 'P26069944', 10800000),
  ('curated-f65a6b9c11379a53', 'P25629199', 420000000),
  ('curated-f65a6b9c11379a53', 'P25360593', 900000),
  ('curated-f65a6b9c11379a53', 'P25869265', 35000000),
  ('curated-f65a6b9c11379a53', 'P26178725', 2430000),
  ('curated-f65a6b9c11379a53', 'P23739151', 880000),
  ('curated-f65a6b9c11379a53', 'P24193241', 2000000),
  ('curated-f65a6b9c11379a53', 'P23619764', 1710000),
  ('curated-f65a6b9c11379a53', 'P22920630', 66000),
  ('curated-f65a6b9c11379a53', 'P24410241', 31680),
  ('curated-f65a6b9c11379a53', 'P26208164', 104000000),
  ('curated-f65a6b9c11379a53', 'P26236506', 150000),
  ('curated-f65a6b9c11379a53', 'P25367429', 121000),
  ('curated-f65a6b9c11379a53', 'P23356807', 435000),
  ('curated-f65a6b9c11379a53', 'P24234970', 18900),
  ('curated-f65a6b9c11379a53', 'P20822564', 12100),
  ('curated-f65a6b9c11379a53', 'P24723843', 4000000),
  ('curated-f65a6b9c11379a53', 'P23539207', 35000),
  ('curated-f65a6b9c11379a53', 'P23954275', 3900000),
  ('curated-f65a6b9c11379a53', 'P25792450', 9800),
  ('curated-f65a6b9c11379a53', 'P25738780', 10900000),
  ('curated-f65a6b9c11379a53', 'P24934777', 1650000),
  ('curated-f65a6b9c11379a53', 'P25643980', 6632000),
  ('curated-f65a6b9c11379a53', 'P24262279', 589000000),
  ('curated-f65a6b9c11379a53', 'P21585905', 12993750),
  ('curated-f65a6b9c11379a53', 'P24396429', 28440000),
  ('curated-f65a6b9c11379a53', 'P24064111', 8984000),
  ('curated-f65a6b9c11379a53', 'P23629171', 25000),
  ('curated-f65a6b9c11379a53', 'P25111447', 87000),
  ('curated-f65a6b9c11379a53', 'P25493630', 240000),
  ('curated-f65a6b9c11379a53', 'P25439537', 290000),
  ('curated-f65a6b9c11379a53', 'P23218073', 1000000),
  ('curated-f65a6b9c11379a53', 'P25489312', 255000),
  ('curated-f65a6b9c11379a53', 'P25329454', 280000),
  ('curated-f65a6b9c11379a53', 'P21069152', 548000),
  ('curated-f65a6b9c11379a53', 'P23902387', 364100),
  ('curated-f65a6b9c11379a53', 'P22271507', 4850000),
  ('curated-f65a6b9c11379a53', 'P25202795', 260000),
  ('curated-f65a6b9c11379a53', 'P24535642', 42800),
  ('curated-f65a6b9c11379a53', 'P23810982', 37540000),
  ('curated-f65a6b9c11379a53', 'P22177289', 1125000),
  ('curated-f65a6b9c11379a53', 'P23682803', 36400),
  ('curated-f65a6b9c11379a53', 'P26024746', 58000),
  ('curated-f65a6b9c11379a53', 'P23343622', 6000),
  ('curated-f65a6b9c11379a53', 'P23829227', 178500),
  ('curated-f65a6b9c11379a53', 'P23388624', 94500),
  ('curated-f65a6b9c11379a53', 'P24436425', 410000),
  ('curated-f65a6b9c11379a53', 'P25051221', 7700000),
  ('curated-f65a6b9c11379a53', 'P25051223', 7700000),
  ('curated-f65a6b9c11379a53', 'P26007475', 12000000),
  ('curated-f65a6b9c11379a53', 'P23208590', 790),
  ('curated-f65a6b9c11379a53', 'P24522374', 91800),
  ('curated-f65a6b9c11379a53', 'P24507084', 293000),
  ('curated-f65a6b9c11379a53', 'P24519347', 107000),
  ('curated-f65a6b9c11379a53', 'P24508762', 71500),
  ('curated-f65a6b9c11379a53', 'P24823615', 39000),
  ('curated-f65a6b9c11379a53', 'P24507094', 214000),
  ('curated-f65a6b9c11379a53', 'P23263940', 242000),
  ('curated-f65a6b9c11379a53', 'P22421175', 214940),
  ('curated-f65a6b9c11379a53', 'P25086077', 84000),
  ('curated-f65a6b9c11379a53', 'P23387716', 2200),
  ('curated-f65a6b9c11379a53', 'P24775200', 350000),
  ('curated-f65a6b9c11379a53', 'P24193283', 35000),
  ('curated-f65a6b9c11379a53', 'P22217900', 462000),
  ('curated-f65a6b9c11379a53', 'P24663762', 26000),
  ('curated-f65a6b9c11379a53', 'P26059644', 285000),
  ('curated-f65a6b9c11379a53', 'P23904362', 204000),
  ('curated-f65a6b9c11379a53', 'P22525512', 9790000),
  ('curated-f65a6b9c11379a53', 'P24731035', 837000),
  ('curated-f65a6b9c11379a53', 'P25254661', 198000),
  ('curated-f65a6b9c11379a53', 'P24356011', 205200),
  ('curated-f65a6b9c11379a53', 'P24917859', 9550000),
  ('curated-f65a6b9c11379a53', 'P23836967', 4620000),
  ('curated-f65a6b9c11379a53', 'P22584622', 1250000),
  ('curated-f65a6b9c11379a53', 'P24362785', 21800000),
  ('curated-f65a6b9c11379a53', 'P23980940', 3520000),
  ('curated-f65a6b9c11379a53', 'P25423844', 64900),
  ('curated-f65a6b9c11379a53', 'P25169091', 16500),
  ('curated-f65a6b9c11379a53', 'P23356450', 270000)
on conflict (question_set, question_id) do nothing;

do $$ begin
  if not exists (select 1 from public.get_quiz_bank_status('curated-f65a6b9c11379a53') where question_count = 104 and answer_fingerprint = 'f70ce5517cdc94b4b64eb490e1247f48') then
    raise exception 'question bank mismatch';
  end if;
end; $$;

commit;
