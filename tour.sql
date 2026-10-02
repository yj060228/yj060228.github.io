-- ════════════════════════════════════════════════════════════════════
-- 써틴 — 매일 코인 · 주간 대회 · 주간 승리 순위
--
-- coins.sql, cash_session.sql, ai_cash.sql 다음에 SQL Editor 에 통째로 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
--
--   · 매일 코인: 한국 시간 하루에 한 번 10만 코인. 관리자 지갑에서 나간다 (발행량은 1억 고정).
--   · 주간: 한국 시간 월요일 0시 ~ 다음 월요일 0시(= 일요일 밤 자정).
--   · 대회: 참가비 5만 코인을 내고 AI 와 4인전 3판. 3판 점수 합으로 순위.
--           한 주에 기록은 하나. 지우고 다시 참가할 수 있다 (참가비를 다시 낸다).
--           상금 1등 100만 · 2등 60만 · 3등 30만 · 4등 10만
--   · 승리 순위: 서버가 AI 를 맡은 판(AI 캐시 게임 · 대회)에서 이긴 횟수. 1등 200만.
--   · 상금은 주가 끝난 뒤 관리자 지갑에서 지급한다.
--     pg_cron 이 켜져 있으면 일요일 밤 자정에 바로, 아니면 그 뒤 첫 접속 때 지급된다.
-- ════════════════════════════════════════════════════════════════════

-- 한국 시간으로 그 주의 월요일
create or replace function public.kst_week(p_at timestamptz default now())
returns date
language sql stable as $$
  select date_trunc('week', p_at at time zone 'Asia/Seoul')::date;
$$;
create or replace function public.kst_today()
returns date
language sql stable as $$
  select (now() at time zone 'Asia/Seoul')::date;
$$;


-- ───────── 매일 코인 ─────────
create or replace function public.daily_status()
returns table (claimed boolean, amount bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  return query select exists (
    select 1 from coin_ledger where ref = 'daily:' || v_me || ':' || kst_today()), 100000::bigint;
end $$;

create or replace function public.daily_claim()
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me    uuid := auth.uid();
  v_house uuid := ai_house();
  v_ref   text;
  v_bal   bigint;
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  if v_house is null or v_house = v_me then raise exception '관리자 계정은 받을 수 없어요.'; end if;
  v_ref := 'daily:' || v_me || ':' || kst_today();
  if exists (select 1 from coin_ledger where ref = v_ref) then
    raise exception '오늘은 이미 받았어요. 내일 다시 받을 수 있어요.';
  end if;
  begin
    perform coin_move(v_house, v_me, 100000, 'daily', v_ref, '매일 코인');
  exception
    when unique_violation then raise exception '오늘은 이미 받았어요. 내일 다시 받을 수 있어요.';
    when others then
      if sqlerrm like '%모자라%' then raise exception '지금은 나눠 줄 코인이 없어요. 관리자에게 알려 주세요.'; end if;
      raise;
  end;
  select balance into v_bal from wallets where user_id = v_me;
  return v_bal;
end $$;


-- ───────── 대회 기록 ─────────
create table if not exists public.tour_runs (
  id          uuid primary key default gen_random_uuid(),
  week        date   not null,
  user_id     uuid   not null references auth.users(id) on delete cascade,
  status      text   not null default 'playing',   -- playing | done
  games_done  int    not null default 0,
  total       int    not null default 0,
  results     int[]  not null default '{}',
  state       jsonb,                               -- 지금 두는 판 (심판만 본다)
  fee         bigint not null default 0,
  version     int    not null default 0,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists tour_runs_one_per_week on public.tour_runs(week, user_id);
create index if not exists tour_runs_board on public.tour_runs(week, status, total desc, finished_at);
alter table public.tour_runs enable row level security;

-- 서버가 AI 를 맡은 판의 결과 (승리 순위용)
create table if not exists public.server_wins (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  week       date not null,
  kind       text not null,          -- cash | tour
  won        boolean not null,
  points     int  not null,
  created_at timestamptz not null default now()
);
create index if not exists server_wins_week on public.server_wins(week, user_id) where won;
alter table public.server_wins enable row level security;

-- 지급한 상금 (지난 주 우승자 보기에도 쓴다)
create table if not exists public.weekly_prizes (
  week     date   not null,
  kind     text   not null,          -- score | wins
  rank     int    not null,
  user_id  uuid   not null,
  value    int    not null,          -- 점수 합 또는 승리 횟수
  amount   bigint not null,
  paid_at  timestamptz not null default now(),
  primary key (week, kind, rank)
);
alter table public.weekly_prizes enable row level security;

-- 정산을 마친 주 (참가자가 없던 주도 다시 보지 않으려고)
create table if not exists public.weekly_settled (
  week     date primary key,
  done_at  timestamptz not null default now()
);
alter table public.weekly_settled enable row level security;


-- 참가: 참가비를 관리자에게 내고 기록을 만든다
create or replace function public.tour_enter(p_user uuid, p_fee bigint, p_state jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_house uuid := ai_house();
  v_week  date := kst_week();
  v_old   tour_runs%rowtype;
  v_id    uuid;
begin
  if v_house is null then raise exception '관리자 계정이 정해지지 않아서 대회를 열 수 없어요.'; end if;
  if v_house = p_user then raise exception '관리자 계정은 대회에 참가할 수 없어요.'; end if;
  perform 1 from wallets where user_id = p_user for update;
  select * into v_old from tour_runs where week = v_week and user_id = p_user;
  if found then
    if v_old.status = 'playing' then raise exception '이미 대회를 진행 중이에요.'; end if;
    raise exception '이번 주 기록이 있어요. 기록을 지우면 다시 참가할 수 있어요.';
  end if;
  if p_fee > 0 then
    begin
      perform coin_move(p_user, v_house, p_fee, 'tour_fee', null, '대회 참가비 ' || v_week);
    exception when others then
      if sqlerrm like '%모자라%' then raise exception '코인이 모자라요. 참가비는 % 코인이에요.', p_fee; end if;
      raise;
    end;
  end if;
  insert into tour_runs(week, user_id, state, fee) values (v_week, p_user, p_state, p_fee)
    returning id into v_id;
  return v_id;
end $$;

-- 기록 지우기 (참가비는 돌려주지 않는다)
create or replace function public.tour_withdraw(p_user uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from tour_runs where week = kst_week() and user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;


-- ───────── 순위표 ─────────
create or replace function public.tour_board(p_week date, p_limit int default 50)
returns table (rank int, user_id uuid, username text, total int, results int[], finished_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select (row_number() over (order by r.total desc, r.finished_at asc))::int,
         r.user_id, coalesce(p.username, '알 수 없음'), r.total, r.results, r.finished_at
    from tour_runs r left join profiles p on p.id = r.user_id
   where r.week = p_week and r.status = 'done'
   order by r.total desc, r.finished_at asc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- 승리 횟수. 같으면 그 횟수에 먼저 다다른 사람이 위
create or replace function public.win_board(p_week date, p_limit int default 50)
returns table (rank int, user_id uuid, username text, wins int, games int, last_win timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (
    select w.user_id,
           count(*) filter (where w.won)::int as wins,
           count(*)::int as games,
           max(w.created_at) filter (where w.won) as last_win
      from server_wins w
     where w.week = p_week
     group by w.user_id
  )
  select (row_number() over (order by g.wins desc, g.last_win asc))::int,
         g.user_id, coalesce(p.username, '알 수 없음'), g.wins, g.games, g.last_win
    from g left join profiles p on p.id = g.user_id
   where g.wins > 0
   order by g.wins desc, g.last_win asc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;


-- ───────── 주간 상금 지급 ─────────
-- 끝난 주(이번 주보다 앞)를 모두 정산한다. 여러 번 불러도 한 번만 준다.
create or replace function public.weekly_payout()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_house uuid := ai_house();
  v_week  date;
  v_amts  bigint[] := array[1000000, 600000, 300000, 100000];
  r       record;
  n       int := 0;
begin
  if v_house is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('thirteen_weekly_payout'));

  for v_week in
    select distinct w from (
      select week as w from tour_runs
      union select week from server_wins
    ) x
    where w < kst_week()
      and not exists (select 1 from weekly_settled s where s.week = x.w)
    order by 1
  loop
    -- 대회: 1 ~ 4등
    for r in select * from tour_board(v_week, 4) loop
      if r.user_id = v_house then continue; end if;
      perform coin_move(v_house, r.user_id, v_amts[r.rank], 'tour_prize',
                        'prize:' || v_week || ':score:' || r.rank, v_week || ' 주 대회 ' || r.rank || '등');
      insert into weekly_prizes(week, kind, rank, user_id, value, amount)
        values (v_week, 'score', r.rank, r.user_id, r.total, v_amts[r.rank]);
      n := n + 1;
    end loop;
    -- 승리 순위: 1등만
    for r in select * from win_board(v_week, 1) loop
      if r.user_id = v_house then continue; end if;
      perform coin_move(v_house, r.user_id, 2000000, 'win_prize',
                        'prize:' || v_week || ':wins:1', v_week || ' 주 승리 1등');
      insert into weekly_prizes(week, kind, rank, user_id, value, amount)
        values (v_week, 'wins', 1, r.user_id, r.wins, 2000000);
      n := n + 1;
    end loop;
    insert into weekly_settled(week) values (v_week);
  end loop;
  return n;
end $$;

-- 지난 주 수상자
create or replace function public.weekly_winners(p_week date)
returns table (kind text, rank int, username text, value int, amount bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select w.kind, w.rank, coalesce(p.username, '알 수 없음'), w.value, w.amount
    from weekly_prizes w left join profiles p on p.id = w.user_id
   where w.week = p_week
   order by w.kind, w.rank;
$$;


-- ───────── 일요일 밤 자정에 자동 지급 (pg_cron 이 켜져 있을 때만) ─────────
-- Supabase: Database → Extensions 에서 pg_cron 을 켜면 됩니다. 꺼져 있어도 첫 접속 때 지급돼요.
-- 한국 시간 월요일 0시 = 세계 표준시 일요일 15시
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'thirteen-weekly-payout';
    perform cron.schedule('thirteen-weekly-payout', '0 15 * * 0', 'select public.weekly_payout()');
  end if;
end $$;


-- ───────── 권한 ─────────
revoke all on function public.daily_status()                 from public, anon;
revoke all on function public.daily_claim()                  from public, anon;
grant execute on function public.daily_status()              to authenticated;
grant execute on function public.daily_claim()               to authenticated;

revoke all on function public.tour_enter(uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.tour_withdraw(uuid)             from public, anon, authenticated;
revoke all on function public.tour_board(date, int)           from public, anon, authenticated;
revoke all on function public.win_board(date, int)            from public, anon, authenticated;
revoke all on function public.weekly_payout()                 from public, anon, authenticated;
revoke all on function public.weekly_winners(date)            from public, anon, authenticated;
grant execute on function public.tour_enter(uuid, bigint, jsonb) to service_role;
grant execute on function public.tour_withdraw(uuid)             to service_role;
grant execute on function public.tour_board(date, int)           to service_role;
grant execute on function public.win_board(date, int)            to service_role;
grant execute on function public.weekly_payout()                 to service_role;
grant execute on function public.weekly_winners(date)            to service_role;
grant execute on function public.kst_week(timestamptz)           to service_role;

revoke all on public.tour_runs, public.server_wins, public.weekly_prizes, public.weekly_settled
  from anon, authenticated;
