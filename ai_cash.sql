-- ════════════════════════════════════════════════════════════════════
-- 써틴 — AI 와 하는 캐시 게임
--
-- coins.sql, cash_session.sql 다음에 SQL Editor 에 통째로 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
--
--   · 게임을 시작하면 그 사람의 코인 전부를 묶는다 (wallets.locked).
--     그동안은 멀티 게임도, 송금도, 다른 게임도 할 수 없다.
--   · 카드를 나누고 AI 가 두는 건 전부 서버(심판)가 한다. 브라우저는 내 패만 안다.
--   · 판이 끝나면 내 승점 x 1점당 금액만큼 관리자(코인을 처음 발행받은 계정)와 주고받는다.
--     잃는 금액은 묶어 둔 코인까지, 따는 금액은 관리자가 가진 코인까지.
--   · 기권하면 그때 내 패의 벌점 x 4 x 1점당 금액을 벌금으로 관리자에게 내고 끝낸다.
--     기권한 판은 기록을 남기지 않고 지운다. (코인 장부에는 벌금이 남는다)
--   · 관리자가 AI 캐시 게임을 끄면 새로 시작할 수 없고, 진행 중이던 판은 모두 취소된다.
--     취소된 판은 정산 없이 묶었던 코인을 그대로 돌려준다.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.ai_games (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid   not null references auth.users(id) on delete restrict,
  status     text   not null default 'active',     -- active | done
  stake      int    not null check (stake > 0),
  n_players  int    not null check (n_players between 2 and 4),
  locked     bigint not null check (locked >= 0),  -- 시작할 때 묶은 코인
  state      jsonb  not null,                      -- 카드와 수순 (심판만 본다)
  version    int    not null default 0,
  result     bigint,                               -- 실제로 오간 코인 (+ 딴 것)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 한 사람은 한 번에 한 판만
create unique index if not exists ai_games_one_active on public.ai_games(user_id) where status = 'active';
alter table public.ai_games enable row level security;
-- 정책 없음: 브라우저에서는 보이지 않습니다. 패가 들어 있으니까요.

-- ───────── 사이트 설정 (관리자가 바꾼다) ─────────
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
-- 정책 없음: 읽고 쓰는 건 심판(서버 함수)이 대신 한다
insert into public.app_settings(key, value) values ('ai_cash', '{"enabled": true}')
  on conflict (key) do nothing;

create or replace function public.ai_cash_enabled()
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value->>'enabled')::boolean from app_settings where key = 'ai_cash'), true);
$$;

-- 관리자 지갑: 코인을 처음 발행받은 계정. 없으면 가장 먼저 등록된 관리자
create or replace function public.ai_house()
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select to_user from coin_ledger where reason = 'genesis' order by id limit 1),
    (select user_id from admins order by created_at limit 1));
$$;


-- ───────── 시작: 코인 전부를 묶고 판을 만든다 ─────────
create or replace function public.ai_cash_open(
  p_user uuid, p_stake int, p_n int, p_min bigint, p_state jsonb)
returns table (game_id uuid, locked_amount bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bal   bigint;
  v_house uuid := ai_house();
  v_id    uuid;
begin
  if p_user is null then raise exception '로그인이 필요해요.'; end if;
  if v_house is null then raise exception '관리자 계정이 정해지지 않아서 캐시 게임을 열 수 없어요.'; end if;
  if v_house = p_user then raise exception '관리자 계정은 AI 캐시 게임을 할 수 없어요.'; end if;
  if not ai_cash_enabled() then raise exception '관리자가 AI 캐시 게임을 꺼 두었어요.'; end if;

  insert into wallets(user_id) values (p_user) on conflict (user_id) do nothing;
  select balance into v_bal from wallets where user_id = p_user for update;

  if exists (select 1 from ai_games where user_id = p_user and status = 'active') then
    raise exception '이미 진행 중인 AI 캐시 게임이 있어요.';
  end if;
  if exists (select 1 from cash_seats where user_id = p_user) then
    raise exception '멀티 캐시 게임에 묶인 코인이 있어요. 그 방을 나간 뒤에 해 주세요.';
  end if;
  if v_bal < greatest(p_min, 1) then
    raise exception '코인이 모자라요.';
  end if;

  update wallets
     set balance = 0, locked = locked + v_bal, updated_at = now()
   where user_id = p_user;
  insert into ai_games(user_id, stake, n_players, locked, state)
    values (p_user, p_stake, p_n, v_bal, p_state)
    returning id into v_id;
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (p_user, null, v_bal, 'escrow', null, 'AI 캐시 게임');
  return query select v_id, v_bal;
end $$;


-- ───────── 끝: 묶은 코인을 풀고 관리자와 주고받는다 ─────────
--   p_delta  : 내가 따면 +, 잃으면 − (기권 벌금은 −)
--   p_forfeit: 기권이면 true → 판을 지운다
-- 같은 판을 두 번 끝내도 한 번만 정산한다.
create or replace function public.ai_cash_close(p_id uuid, p_delta bigint, p_forfeit boolean)
returns table (delta bigint, balance bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  g       ai_games%rowtype;
  v_house uuid := ai_house();
  v_hbal  bigint;
  v_move  bigint;
begin
  select * into g from ai_games where id = p_id for update;
  if not found then raise exception '그런 게임이 없어요.'; end if;
  if g.status <> 'active' then
    return query select g.result, (select w.balance from wallets w where w.user_id = g.user_id);
    return;
  end if;

  -- 교착을 피하려고 id 순서대로 잠급니다
  if g.user_id < v_house then
    perform 1 from wallets where user_id = g.user_id for update;
    perform 1 from wallets where user_id = v_house for update;
  else
    perform 1 from wallets where user_id = v_house for update;
    perform 1 from wallets where user_id = g.user_id for update;
  end if;
  select w.balance into v_hbal from wallets w where w.user_id = v_house;

  if p_delta < 0 then
    v_move := -least(-p_delta, g.locked);          -- 묶어 둔 만큼까지만 잃는다
  else
    v_move := least(p_delta, coalesce(v_hbal, 0)); -- 관리자가 가진 만큼까지만 준다
  end if;

  -- 묶은 코인을 풀고, 오간 만큼 더하고 뺀다
  update wallets w
     set locked  = w.locked - least(w.locked, g.locked),
         balance = w.balance + least(w.locked, g.locked) + v_move,
         updated_at = now()
   where w.user_id = g.user_id;
  update wallets w
     set balance = w.balance - v_move, updated_at = now()
   where w.user_id = v_house;

  if g.locked > 0 then
    insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
      values (null, g.user_id, g.locked, 'cashout', null, 'AI 캐시 게임');
  end if;
  if v_move > 0 then
    insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
      values (v_house, g.user_id, v_move, 'ai_win', 'ai:' || p_id, 'AI 캐시 게임');
  elsif v_move < 0 then
    insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
      values (g.user_id, v_house, -v_move, case when p_forfeit then 'ai_forfeit' else 'ai_loss' end,
              'ai:' || p_id, 'AI 캐시 게임');
  end if;

  if p_forfeit then
    delete from ai_games where id = p_id;          -- 기권한 판은 남기지 않는다
  else
    update ai_games set status = 'done', result = v_move, updated_at = now() where id = p_id;
  end if;
  return query select v_move, (select w.balance from wallets w where w.user_id = g.user_id);
end $$;


-- ───────── 켜고 끄기 ─────────
-- 끄면 진행 중이던 판을 모두 취소한다: 정산 없이 묶었던 코인을 돌려주고 판은 지운다.
-- 돌려준 판의 수를 돌려준다.
create or replace function public.ai_cash_set_enabled(p_on boolean)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record; n int := 0;
begin
  insert into app_settings(key, value) values ('ai_cash', jsonb_build_object('enabled', p_on))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  if p_on then return 0; end if;

  for g in select * from ai_games where status = 'active' order by user_id for update loop
    update wallets w
       set locked  = w.locked - least(w.locked, g.locked),
           balance = w.balance + least(w.locked, g.locked),
           updated_at = now()
     where w.user_id = g.user_id;
    if g.locked > 0 then
      insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
        values (null, g.user_id, g.locked, 'refund', null, 'AI 캐시 게임 취소');
    end if;
    delete from ai_games where id = g.id;          -- 취소된 판은 남기지 않는다
    n := n + 1;
  end loop;
  return n;
end $$;


-- ───────── 권한: 심판(서버 함수)만 부를 수 있습니다 ─────────
revoke all on function public.ai_house()                                    from public, anon, authenticated;
revoke all on function public.ai_cash_open(uuid, int, int, bigint, jsonb)    from public, anon, authenticated;
revoke all on function public.ai_cash_close(uuid, bigint, boolean)           from public, anon, authenticated;
grant execute on function public.ai_house()                                 to service_role;
grant execute on function public.ai_cash_open(uuid, int, int, bigint, jsonb) to service_role;
grant execute on function public.ai_cash_close(uuid, bigint, boolean)        to service_role;
revoke all on function public.ai_cash_enabled()                              from public, anon, authenticated;
revoke all on function public.ai_cash_set_enabled(boolean)                   from public, anon, authenticated;
grant execute on function public.ai_cash_enabled()                          to service_role;
grant execute on function public.ai_cash_set_enabled(boolean)               to service_role;
revoke all on public.ai_games from anon, authenticated;
revoke all on public.app_settings from anon, authenticated;
