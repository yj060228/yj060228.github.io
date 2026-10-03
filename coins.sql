-- ════════════════════════════════════════════════════════════════════
-- 써틴 게임머니(코인)
--
-- 설계 원칙
--   1. 잔액은 브라우저가 절대 고칠 수 없다.
--      wallets 표에는 읽기 정책만 있고 쓰기 정책이 하나도 없다.
--      정책이 없으면 RLS 아래에서는 무조건 거부된다.
--   2. 모든 이동은 아래 함수 안에서만 일어난다.
--      함수는 SECURITY DEFINER 이고, 누가 불렀는지 auth.uid() 로 직접 확인한다.
--      search_path 를 고정해서 함수 가로채기를 막는다.
--   3. 처음 발행량은 1억이다 (mint_2b.sql 로 20억을 더 발행해 21억). 코인은 새로 생기지 않고 자리만 옮긴다.
--      admin 계정이 처음에 전부 들고 있다가 나눠 준다.
--   4. 같은 정산이 두 번 일어나지 않게 ref 에 고유 색인을 건다.
--
-- SQL Editor 에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- 캐시 게임 세션 바이인은 이 파일 다음에 cash_session.sql 을 실행하세요.
-- ════════════════════════════════════════════════════════════════════

-- ───────── 지갑 ─────────
-- balance : 지금 쓸 수 있는 코인
-- locked  : 캐시 게임에 묶어 둔 코인 (판이 끝나면 정산되어 돌아온다)
create table if not exists public.wallets (
  user_id    uuid primary key references auth.users(id) on delete restrict,
  balance    bigint not null default 0 check (balance >= 0),
  locked     bigint not null default 0 check (locked  >= 0),
  updated_at timestamptz not null default now()
);
alter table public.wallets enable row level security;

drop policy if exists "내 지갑만 보기" on public.wallets;
create policy "내 지갑만 보기" on public.wallets
  for select using (auth.uid() = user_id);
-- 쓰기 정책은 일부러 만들지 않습니다. 브라우저에서는 수정이 불가능합니다.

-- ───────── 장부 ─────────
create table if not exists public.coin_ledger (
  id         bigserial primary key,
  from_user  uuid,
  to_user    uuid,
  amount     bigint not null check (amount > 0),
  reason     text   not null,   -- genesis | grant | transfer | escrow | settle | refund
  ref        text,              -- 중복 처리를 막는 열쇠
  memo       text,
  created_at timestamptz not null default now()
);
create unique index if not exists coin_ledger_ref_uniq
  on public.coin_ledger(ref) where ref is not null;
create index if not exists coin_ledger_from_idx on public.coin_ledger(from_user, created_at desc);
create index if not exists coin_ledger_to_idx   on public.coin_ledger(to_user,   created_at desc);
alter table public.coin_ledger enable row level security;

drop policy if exists "내 거래만 보기" on public.coin_ledger;
create policy "내 거래만 보기" on public.coin_ledger
  for select using (auth.uid() = from_user or auth.uid() = to_user);

-- ───────── 캐시 게임 결과 ─────────
create table if not exists public.cash_results (
  id         bigserial primary key,
  game_ref   text not null,
  room_code  text,
  user_id    uuid not null,
  stake      int  not null,
  points     int  not null,   -- 그 판의 승점
  delta      bigint not null, -- 실제로 오간 코인 (음수면 잃은 것)
  created_at timestamptz not null default now()
);
create index if not exists cash_results_user_idx on public.cash_results(user_id, created_at desc);
alter table public.cash_results enable row level security;

drop policy if exists "내 정산만 보기" on public.cash_results;
create policy "내 정산만 보기" on public.cash_results
  for select using (auth.uid() = user_id);

-- ───────── 묶어 둔 판돈 ─────────
-- 방이 중간에 버려져도 묶인 코인을 돌려줄 수 있게 남겨 둔다.
create table if not exists public.cash_escrows (
  ref        text primary key,
  room_code  text,
  users      uuid[] not null,
  buyin      bigint not null,
  stake      int    not null,
  settled    boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.cash_escrows enable row level security;
-- 정책 없음: 브라우저에서는 보이지도 않습니다.

-- ───────── 관리자 ─────────
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- 정책 없음: 브라우저에서는 읽지도 쓰지도 못합니다. SQL Editor 에서만 다룹니다.

-- ───────── 방에 판돈 칸 추가 ─────────
-- (멀티플레이 SQL 을 먼저 실행한 경우에만 의미가 있습니다)
do $$ begin
  if to_regclass('public.rooms') is not null then
    alter table public.rooms add column if not exists stake int not null default 0;
    -- 방장이 정한 바이인. 0 이면 옛 방식(1점당 금액의 100배)을 씁니다.
    alter table public.rooms add column if not exists buyin bigint not null default 0;
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 코인 이동의 유일한 통로
-- 바깥에서는 부를 수 없습니다 (맨 아래에서 권한을 거둬들입니다).
-- ════════════════════════════════════════════════════════════════════
create or replace function public.coin_move(
  p_from uuid, p_to uuid, p_amount bigint, p_reason text,
  p_ref text default null, p_memo text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_bal bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception '금액이 올바르지 않아요.';
  end if;
  if p_from is null or p_to is null then
    raise exception '보내는 사람과 받는 사람이 필요해요.';
  end if;
  if p_from = p_to then
    raise exception '자기 자신에게는 보낼 수 없어요.';
  end if;

  insert into wallets(user_id) values (p_from) on conflict (user_id) do nothing;
  insert into wallets(user_id) values (p_to)   on conflict (user_id) do nothing;

  -- 교착을 피하려고 항상 같은 순서로 잠급니다
  if p_from < p_to then
    perform 1 from wallets where user_id = p_from for update;
    perform 1 from wallets where user_id = p_to   for update;
  else
    perform 1 from wallets where user_id = p_to   for update;
    perform 1 from wallets where user_id = p_from for update;
  end if;

  select balance into v_bal from wallets where user_id = p_from;
  if v_bal < p_amount then
    raise exception '코인이 모자라요.';
  end if;

  update wallets set balance = balance - p_amount, updated_at = now() where user_id = p_from;
  update wallets set balance = balance + p_amount, updated_at = now() where user_id = p_to;
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (p_from, p_to, p_amount, p_reason, p_ref, p_memo);
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 브라우저에서 부르는 함수
-- ════════════════════════════════════════════════════════════════════

-- 내 잔액 (없으면 0원짜리 지갑을 만들어 준다)
create or replace function public.my_wallet()
returns table (balance bigint, locked bigint, is_admin boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  insert into wallets(user_id) values (v_me) on conflict (user_id) do nothing;
  return query
    select w.balance, w.locked, exists(select 1 from admins a where a.user_id = v_me)
    from wallets w where w.user_id = v_me;
end $$;


-- 아이디로 코인 보내기
create or replace function public.coin_transfer(p_to_username text, p_amount bigint)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := auth.uid();
  v_to uuid;
  v_recent int;
  v_bal bigint;
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  if p_amount is null or p_amount <> floor(p_amount) or p_amount <= 0 then
    raise exception '보낼 금액을 1 이상의 정수로 적어 주세요.';
  end if;
  if p_amount > 100000000 then raise exception '한 번에 보낼 수 있는 금액을 넘었어요.'; end if;

  select id into v_to from profiles
    where lower(username) = lower(btrim(coalesce(p_to_username, '')));
  if v_to is null then raise exception '그런 아이디가 없어요.'; end if;
  if v_to = v_me then raise exception '자기 자신에게는 보낼 수 없어요.'; end if;

  -- 너무 잦은 송금 막기
  select count(*) into v_recent from coin_ledger
    where from_user = v_me and reason = 'transfer' and created_at > now() - interval '1 minute';
  if v_recent >= 10 then raise exception '잠시 뒤에 다시 시도해 주세요.'; end if;

  perform coin_move(v_me, v_to, p_amount, 'transfer', null, null);

  select balance into v_bal from wallets where user_id = v_me;
  return v_bal;
end $$;


-- 내 코인 내역 (상대 아이디를 붙여서 돌려준다)
create or replace function public.coin_history(p_limit int default 30)
returns table (
  created_at timestamptz, amount bigint, reason text,
  incoming boolean, other_name text, memo text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  return query
    select l.created_at, l.amount, l.reason,
           (l.to_user = v_me) as incoming,
           coalesce(p.username, '') as other_name,
           l.memo
      from coin_ledger l
      left join profiles p
        on p.id = case when l.to_user = v_me then l.from_user else l.to_user end
     where l.from_user = v_me or l.to_user = v_me
     order by l.created_at desc
     limit least(greatest(coalesce(p_limit, 30), 1), 100);
end $$;


-- 관리자가 지급하기 (admins 에 등록된 계정만)
create or replace function public.admin_grant(p_username text, p_amount bigint)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := auth.uid();
  v_to uuid;
  v_bal bigint;
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  if not exists (select 1 from admins where user_id = v_me) then
    raise exception '권한이 없어요.';
  end if;
  if p_amount is null or p_amount <> floor(p_amount) or p_amount <= 0 then
    raise exception '지급 금액을 1 이상의 정수로 적어 주세요.';
  end if;

  select id into v_to from profiles
    where lower(username) = lower(btrim(coalesce(p_username, '')));
  if v_to is null then raise exception '그런 아이디가 없어요.'; end if;

  perform coin_move(v_me, v_to, p_amount, 'grant', null, null);
  select balance into v_bal from wallets where user_id = v_me;
  return v_bal;
end $$;


-- 관리자가 코인을 되가져오기
--   · 캐시 게임에 묶인 코인(locked)은 건드리지 않습니다. 판이 끝나야 정산되니까요.
--   · 가진 것보다 많이 적으면 있는 만큼만 가져옵니다.
--   · 장부에 '회수' 로 남아서 당사자도 자기 내역에서 볼 수 있습니다.
create or replace function public.admin_reclaim(p_username text, p_amount bigint)
returns table (taken bigint, remaining bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me   uuid := auth.uid();
  v_from uuid;
  v_bal  bigint;
  v_amt  bigint;
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  if not exists (select 1 from admins where user_id = v_me) then
    raise exception '권한이 없어요.';
  end if;
  if p_amount is null or p_amount <> floor(p_amount) or p_amount <= 0 then
    raise exception '회수할 금액을 1 이상의 정수로 적어 주세요.';
  end if;

  select id into v_from from profiles
    where lower(username) = lower(btrim(coalesce(p_username, '')));
  if v_from is null then raise exception '그런 아이디가 없어요.'; end if;
  if v_from = v_me then raise exception '자기 자신에게서는 회수할 수 없어요.'; end if;

  select balance into v_bal from wallets where user_id = v_from for update;
  if v_bal is null or v_bal <= 0 then raise exception '회수할 코인이 없어요.'; end if;

  v_amt := least(p_amount, v_bal);
  perform coin_move(v_from, v_me, v_amt, 'reclaim', null, null);

  select balance into v_bal from wallets where user_id = v_from;
  return query select v_amt, v_bal;
end $$;


-- ───────── 관리자용 조회 ─────────
-- 코인을 하나라도 갖고 있는 사람 목록. admins 에 등록된 계정만 볼 수 있습니다.
create or replace function public.admin_wallets(p_limit int default 200)
returns table (username text, balance bigint, locked bigint, held bigint, is_admin boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  if not exists (select 1 from admins where user_id = v_me) then
    raise exception '권한이 없어요.';
  end if;
  return query
    select coalesce(p.username, '(아이디 없음)')::text,
           w.balance, w.locked, (w.balance + w.locked)::bigint,
           exists (select 1 from admins a where a.user_id = w.user_id)
      from wallets w
      left join profiles p on p.id = w.user_id
     where w.balance + w.locked > 0
     order by (w.balance + w.locked) desc, coalesce(p.username, '')
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

-- 전체 현황 한 줄 요약
create or replace function public.admin_coin_summary()
returns table (issued bigint, held bigint, ok boolean, holders int,
               admin_held bigint, circulating bigint, locked_total bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception '로그인이 필요해요.'; end if;
  if not exists (select 1 from admins where user_id = v_me) then
    raise exception '권한이 없어요.';
  end if;
  return query
    select
      coalesce((select sum(l.amount) from coin_ledger l where l.reason = 'genesis'), 0)::bigint,
      coalesce((select sum(w.balance + w.locked) from wallets w), 0)::bigint,
      coalesce((select sum(l.amount) from coin_ledger l where l.reason = 'genesis'), 0)
        = coalesce((select sum(w.balance + w.locked) from wallets w), 0),
      (select count(*) from wallets w
        where w.balance + w.locked > 0
          and not exists (select 1 from admins a where a.user_id = w.user_id))::int,
      coalesce((select sum(w.balance + w.locked) from wallets w
        where exists (select 1 from admins a where a.user_id = w.user_id)), 0)::bigint,
      coalesce((select sum(w.balance + w.locked) from wallets w
        where not exists (select 1 from admins a where a.user_id = w.user_id)), 0)::bigint,
      coalesce((select sum(w.locked) from wallets w), 0)::bigint;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 캐시 게임 — 서버 함수(심판)만 부를 수 있습니다
-- ════════════════════════════════════════════════════════════════════

-- 판 시작: 참가자마다 바이인을 묶어 둔다
create or replace function public.cash_start(
  p_ref text, p_room text, p_users uuid[], p_buyin bigint, p_stake int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u uuid;
  v_bal bigint;
  v_n int := coalesce(array_length(p_users, 1), 0);
begin
  if v_n < 2 then raise exception '참가자가 모자라요.'; end if;
  if p_buyin <= 0 then raise exception '판돈이 올바르지 않아요.'; end if;
  if exists (select 1 from cash_escrows where ref = p_ref) then return; end if;

  -- 교착을 피하려고 id 순서대로 잠급니다
  for u in select distinct x from unnest(p_users) x order by 1 loop
    insert into wallets(user_id) values (u) on conflict (user_id) do nothing;
    select balance into v_bal from wallets where user_id = u for update;
    if v_bal < p_buyin then
      raise exception '코인이 모자란 사람이 있어요.';
    end if;
  end loop;

  update wallets
     set balance = balance - p_buyin, locked = locked + p_buyin, updated_at = now()
   where user_id = any(p_users);

  insert into cash_escrows(ref, room_code, users, buyin, stake)
    values (p_ref, p_room, p_users, p_buyin, p_stake);
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (null, null, p_buyin * v_n, 'escrow', p_ref, p_room);
end $$;


-- 판 종료: 벌점 1점당 p_stake 코인으로 정산한다
--   · 한 판에 잃는 금액은 묶어 둔 바이인까지로 제한한다
--   · 상한에 걸리면 딴 사람 몫을 같은 비율로 줄여서 합을 0으로 맞춘다
create or replace function public.cash_settle(
  p_ref text, p_users uuid[], p_points int[])
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e            cash_escrows%rowtype;
  v_n          int;
  i            int;
  v_raw        bigint;
  v_loss       bigint[] := '{}';
  v_gain_raw   bigint[] := '{}';
  v_delta      bigint[] := '{}';
  v_total_loss bigint := 0;
  v_total_gain bigint := 0;
  v_paid       bigint := 0;
  v_top        int := 0;
  v_moved      bigint := 0;
begin
  select * into e from cash_escrows where ref = p_ref for update;
  if not found then return; end if;          -- 캐시 방이 아니었다
  if e.settled then return; end if;          -- 이미 정산했다 (두 번 지급 방지)

  v_n := coalesce(array_length(e.users, 1), 0);
  if coalesce(array_length(p_users, 1), 0) <> v_n
     or coalesce(array_length(p_points, 1), 0) <> v_n then
    raise exception '정산 자료가 맞지 않아요.';
  end if;
  -- 묶어 둘 때의 사람과 정산할 때의 사람이 같아야 한다
  if exists (select 1 from unnest(p_users) x where x <> all(e.users))
     or exists (select 1 from unnest(e.users) x where x <> all(p_users)) then
    raise exception '정산 대상이 맞지 않아요.';
  end if;
  -- 승점은 합이 0이어야 한다
  if (select coalesce(sum(x), 0) from unnest(p_points) x) <> 0 then
    raise exception '승점 합이 0이 아니에요.';
  end if;

  for i in 1..v_n loop
    v_raw := p_points[i]::bigint * e.stake;
    if v_raw < 0 then
      v_loss[i]     := least(-v_raw, e.buyin);
      v_gain_raw[i] := 0;
    else
      v_loss[i]     := 0;
      v_gain_raw[i] := v_raw;
    end if;
    v_total_loss := v_total_loss + v_loss[i];
    v_total_gain := v_total_gain + v_gain_raw[i];
  end loop;

  for i in 1..v_n loop
    if v_gain_raw[i] > 0 and v_total_gain > 0 then
      v_delta[i] := (v_gain_raw[i] * v_total_loss) / v_total_gain;   -- 정수 나눗셈
      v_paid := v_paid + v_delta[i];
      if v_top = 0 or v_gain_raw[i] > v_gain_raw[v_top] then v_top := i; end if;
    else
      v_delta[i] := -v_loss[i];
    end if;
  end loop;
  -- 나눗셈에서 버린 나머지는 제일 크게 딴 사람에게
  if v_top > 0 and v_total_loss > v_paid then
    v_delta[v_top] := v_delta[v_top] + (v_total_loss - v_paid);
  end if;

  for i in 1..v_n loop
    update wallets
       set locked  = locked  - e.buyin,
           balance = balance + e.buyin + v_delta[i],
           updated_at = now()
     where user_id = p_users[i];
    insert into cash_results(game_ref, room_code, user_id, stake, points, delta)
      values (p_ref, e.room_code, p_users[i], e.stake, p_points[i], v_delta[i]);
    if v_delta[i] > 0 then v_moved := v_moved + v_delta[i]; end if;
  end loop;

  update cash_escrows set settled = true where ref = p_ref;
  if v_moved > 0 then
    insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
      values (null, null, v_moved, 'settle', p_ref || ':settle', e.room_code);
  end if;
end $$;


-- 판이 엎어졌을 때 묶어 둔 코인 돌려주기
create or replace function public.cash_refund(p_ref text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e cash_escrows%rowtype;
begin
  select * into e from cash_escrows where ref = p_ref for update;
  if not found or e.settled then return; end if;
  -- least(locked, buyin) 을 쓰는 이유: 묶인 금액이 어떤 이유로든 모자라도
  -- 음수가 되어 환불 전체가 멈추는 일이 없게 합니다.
  update wallets
     set locked  = locked  - least(locked, e.buyin),
         balance = balance + least(locked, e.buyin),
         updated_at = now()
   where user_id = any(e.users);
  update cash_escrows set settled = true where ref = p_ref;
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (null, null, e.buyin * array_length(e.users, 1), 'refund', p_ref || ':refund', e.room_code);
end $$;


-- 버려진 방의 묶인 코인 정리 (하루가 지나면 돌려준다)
create or replace function public.cleanup_cash()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select ref from cash_escrows
            where not settled and created_at < now() - interval '1 day' loop
    -- 한 건이 잘못돼도 나머지 환불이 막히지 않게 합니다
    begin
      perform cash_refund(r.ref);
      n := n + 1;
    exception when others then null;
    end;
  end loop;
  return n;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 처음 한 번: 관리자 계정을 정하고 1억 코인을 넣는다
--   SQL Editor 에서   select admin_setup('내아이디');   처럼 실행하세요.
--   브라우저에서는 부를 수 없습니다.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.admin_setup(p_username text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from profiles
    where lower(username) = lower(btrim(coalesce(p_username, '')));
  if v_id is null then
    return '그런 아이디가 없어요. 먼저 사이트에서 회원가입을 해 주세요.';
  end if;

  insert into admins(user_id) values (v_id) on conflict (user_id) do nothing;
  insert into wallets(user_id) values (v_id) on conflict (user_id) do nothing;

  if exists (select 1 from coin_ledger where reason = 'genesis') then
    return p_username || ' 을(를) 관리자로 지정했어요. 코인은 이미 발행되어 있어서 다시 발행하지 않았습니다.';
  end if;

  update wallets set balance = balance + 100000000, updated_at = now() where user_id = v_id;
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (null, v_id, 100000000, 'genesis', 'genesis', '최초 발행');
  return p_username || ' 을(를) 관리자로 지정하고 1억 코인을 넣었어요.';
end $$;


-- 총량 점검: 발행량과 실제 합계가 같은지 본다
create or replace function public.coin_audit()
returns table (issued bigint, held bigint, ok boolean)
language sql security definer set search_path = public, pg_temp as $$
  select
    coalesce((select sum(amount) from coin_ledger where reason = 'genesis'), 0)::bigint,
    coalesce((select sum(balance + locked) from wallets), 0)::bigint,
    coalesce((select sum(amount) from coin_ledger where reason = 'genesis'), 0)
      = coalesce((select sum(balance + locked) from wallets), 0);
$$;


-- ════════════════════════════════════════════════════════════════════
-- 권한 — 여기가 제일 중요합니다
-- 기본값으로는 누구나 함수를 부를 수 있어서, 필요한 것만 남기고 거둬들입니다.
-- ════════════════════════════════════════════════════════════════════
revoke all on function public.coin_move(uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.cash_start(text, text, uuid[], bigint, int)     from public, anon, authenticated;
revoke all on function public.cash_settle(text, uuid[], int[])                from public, anon, authenticated;
revoke all on function public.cash_refund(text)                               from public, anon, authenticated;
revoke all on function public.cleanup_cash()                                  from public, anon, authenticated;
revoke all on function public.admin_setup(text)                               from public, anon, authenticated;
revoke all on function public.coin_audit()                                    from public, anon, authenticated;

-- 심판(서버 함수)만 쓰는 것들
grant execute on function public.cash_start(text, text, uuid[], bigint, int) to service_role;
grant execute on function public.cash_settle(text, uuid[], int[])            to service_role;
grant execute on function public.cash_refund(text)                           to service_role;
grant execute on function public.cleanup_cash()                              to service_role;

-- 로그인한 사람만 쓰는 것들 (anon 에게는 주지 않습니다)
revoke all on function public.my_wallet()                      from public, anon;
revoke all on function public.coin_transfer(text, bigint)      from public, anon;
revoke all on function public.coin_history(int)                from public, anon;
revoke all on function public.admin_grant(text, bigint)        from public, anon;
revoke all on function public.admin_reclaim(text, bigint)      from public, anon;
grant execute on function public.admin_reclaim(text, bigint)   to authenticated;
revoke all on function public.admin_wallets(int)               from public, anon;
revoke all on function public.admin_coin_summary()             from public, anon;
grant execute on function public.my_wallet()                   to authenticated;
grant execute on function public.coin_transfer(text, bigint)   to authenticated;
grant execute on function public.coin_history(int)             to authenticated;
grant execute on function public.admin_grant(text, bigint)     to authenticated;
-- 아래 둘은 로그인한 사람이면 부를 수는 있지만, 함수 안에서 관리자인지 다시 확인합니다.
grant execute on function public.admin_wallets(int)            to authenticated;
grant execute on function public.admin_coin_summary()          to authenticated;

-- 표 자체에 대한 쓰기 권한도 거둬들입니다 (RLS 와 이중 잠금)
revoke insert, update, delete on public.wallets      from anon, authenticated;
revoke insert, update, delete on public.coin_ledger  from anon, authenticated;
revoke insert, update, delete on public.cash_results from anon, authenticated;
revoke all on public.cash_escrows from anon, authenticated;
revoke all on public.admins       from anon, authenticated;
