-- ════════════════════════════════════════════════════════════════════
-- 써틴 캐시 게임 — 세션 바이인
--
-- coins.sql 을 먼저 실행한 뒤, 이 파일을 SQL Editor 에 통째로 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
--
-- 예전 방식: 판마다 바이인을 묶고 판이 끝나면 풀었다.
--   → 전재산이 바이인과 딱 같던 사람이 한 판 지면, 다음 판 바이인을 못 내서 더 못 했다.
--
-- 새 방식: 방에 들어올 때 바이인을 한 번 묶고, 방을 나갈 때 남은 만큼 돌려준다.
--   · 묶인 코인은 wallets.locked 에 들어 있어서 코인 화면의 '묶임' 으로 보인다.
--   · 판이 끝날 때마다 묶인 코인(stack) 안에서 주고받는다.
--   · 바이인보다 적게 남아도 계속 할 수 있다.
--   · 다 잃으면(stack = 0) 관전만 할 수 있다.
--   · 한 판에 잃는 금액은 그 사람에게 남은 stack 까지다.
--     상한에 걸리면 딴 사람 몫을 같은 비율로 줄여서 합을 0으로 맞춘다.
-- ════════════════════════════════════════════════════════════════════

-- ───────── 방마다, 사람마다 묶여 있는 코인 ─────────
create table if not exists public.cash_seats (
  room_code  text   not null,
  user_id    uuid   not null references auth.users(id) on delete restrict,
  buyin      bigint not null check (buyin > 0),        -- 처음 묶은 금액
  stack      bigint not null check (stack >= 0),       -- 지금 남은 금액
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room_code, user_id)
);
alter table public.cash_seats enable row level security;
-- 정책 없음: 브라우저에서는 보이지 않습니다. 남은 금액은 심판이 방 상태에 실어서 보여 줍니다.

-- 같은 판이 두 번 정산되지 않게 하는 표
create table if not exists public.cash_seat_rounds (
  ref        text primary key,
  room_code  text not null,
  created_at timestamptz not null default now()
);
alter table public.cash_seat_rounds enable row level security;


-- ════════════════════════════════════════════════════════════════════
-- 바이인: 방에 들어올 때 한 번 묶는다
--   이미 이 방에 묶어 둔 코인이 있으면(다 잃어서 0 이어도) 다시 묶지 않는다.
--   돌려주는 값은 지금 남은 금액.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.seat_buyin(p_room text, p_user uuid, p_buyin bigint)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bal   bigint;
  v_stack bigint;
begin
  if p_room is null or p_user is null then raise exception '방과 사람이 필요해요.'; end if;
  if p_buyin is null or p_buyin <= 0 then raise exception '바이인이 올바르지 않아요.'; end if;

  insert into wallets(user_id) values (p_user) on conflict (user_id) do nothing;
  select balance into v_bal from wallets where user_id = p_user for update;

  select stack into v_stack from cash_seats
   where room_code = p_room and user_id = p_user for update;
  if found then return v_stack; end if;

  if v_bal < p_buyin then raise exception '코인이 모자라요.'; end if;

  update wallets
     set balance = balance - p_buyin, locked = locked + p_buyin, updated_at = now()
   where user_id = p_user;
  insert into cash_seats(room_code, user_id, buyin, stack)
    values (p_room, p_user, p_buyin, p_buyin);
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (p_user, null, p_buyin, 'escrow', null, p_room);
  return p_buyin;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 판 정산: 벌점 1점당 p_stake 코인을, 묶어 둔 금액 안에서 주고받는다
--   p_users[i] 의 승점이 p_points[i]. 승점 합은 0 이어야 한다.
--   같은 p_ref 로 두 번 불러도 한 번만 정산하고, 결과는 매번 똑같이 돌려준다.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.seat_settle(
  p_ref text, p_room text, p_users uuid[], p_points int[], p_stake int)
returns table (user_id uuid, points int, delta bigint, stack bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_n          int := coalesce(array_length(p_users, 1), 0);
  i            int;
  u            uuid;
  v_raw        bigint;
  v_stack      bigint[] := '{}';
  v_loss       bigint[] := '{}';
  v_gain_raw   bigint[] := '{}';
  v_delta      bigint[] := '{}';
  v_total_loss bigint := 0;
  v_total_gain bigint := 0;
  v_paid       bigint := 0;
  v_top        int := 0;
  v_moved      bigint := 0;
  v_new        boolean;
begin
  if p_ref is null or p_room is null then raise exception '정산 자료가 맞지 않아요.'; end if;
  insert into cash_seat_rounds(ref, room_code) values (p_ref, p_room)
    on conflict (ref) do nothing;
  v_new := found;

  if v_new then
    if v_n < 2 or coalesce(array_length(p_points, 1), 0) <> v_n then
      raise exception '정산 자료가 맞지 않아요.';
    end if;
    if p_stake is null or p_stake <= 0 then raise exception '판돈이 올바르지 않아요.'; end if;
    if (select count(distinct x) from unnest(p_users) x) <> v_n then
      raise exception '같은 사람이 두 번 들어 있어요.';
    end if;
    if (select coalesce(sum(x), 0) from unnest(p_points) x) <> 0 then
      raise exception '승점 합이 0이 아니에요.';
    end if;

    -- 교착을 피하려고 id 순서대로 잠급니다
    for u in select distinct x from unnest(p_users) x order by 1 loop
      perform 1 from wallets w where w.user_id = u for update;
      perform 1 from cash_seats s where s.room_code = p_room and s.user_id = u for update;
      if not found then raise exception '이 방에 바이인이 없는 사람이 있어요.'; end if;
    end loop;

    for i in 1..v_n loop
      v_stack[i] := (select s.stack from cash_seats s
                      where s.room_code = p_room and s.user_id = p_users[i]);
      v_raw := p_points[i]::bigint * p_stake;
      if v_raw < 0 then
        v_loss[i]     := least(-v_raw, v_stack[i]);   -- 남은 금액까지만 잃는다
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
      update cash_seats s
         set stack = s.stack + v_delta[i], updated_at = now()
       where s.room_code = p_room and s.user_id = p_users[i];
      update wallets w
         set locked = w.locked + v_delta[i], updated_at = now()
       where w.user_id = p_users[i];
      insert into cash_results(game_ref, room_code, user_id, stake, points, delta)
        values (p_ref, p_room, p_users[i], p_stake, p_points[i], v_delta[i]);
      if v_delta[i] > 0 then v_moved := v_moved + v_delta[i]; end if;
    end loop;

    if v_moved > 0 then
      insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
        values (null, null, v_moved, 'settle', p_ref || ':settle', p_room);
    end if;
  end if;

  return query
    select r.user_id, r.points, r.delta, coalesce(s.stack, 0)::bigint
      from cash_results r
      left join cash_seats s on s.room_code = r.room_code and s.user_id = r.user_id
     where r.game_ref = p_ref
     order by r.id;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 방을 나갈 때: 남은 금액을 지갑으로 돌려준다
--   돌려준 금액을 돌려준다. 묶어 둔 게 없으면 0.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.seat_cashout(p_room text, p_user uuid)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stack bigint;
begin
  perform 1 from wallets where user_id = p_user for update;
  delete from cash_seats
   where room_code = p_room and user_id = p_user
  returning stack into v_stack;
  if not found then return 0; end if;

  if v_stack > 0 then
    update wallets
       set locked  = locked  - least(locked, v_stack),
           balance = balance + least(locked, v_stack),
           updated_at = now()
     where user_id = p_user;
    insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
      values (null, p_user, v_stack, 'cashout', null, p_room);
  end if;
  return v_stack;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- 버려진 방의 묶인 코인 돌려주기
--   방이 지워졌거나 12시간 넘게 아무 일도 없던 방이 대상입니다.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.cleanup_seats()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in
    select s.room_code, s.user_id from cash_seats s
     where not exists (select 1 from rooms m where m.code = s.room_code)
        or exists (select 1 from rooms m
                    where m.code = s.room_code and m.updated_at < now() - interval '12 hours')
  loop
    begin
      perform seat_cashout(r.room_code, r.user_id);
      n := n + 1;
    exception when others then null;   -- 한 건이 잘못돼도 나머지는 돌려준다
    end;
  end loop;
  return n;
end $$;


-- ───────── 권한: 심판(서버 함수)만 부를 수 있습니다 ─────────
revoke all on function public.seat_buyin(text, uuid, bigint)                  from public, anon, authenticated;
revoke all on function public.seat_settle(text, text, uuid[], int[], int)     from public, anon, authenticated;
revoke all on function public.seat_cashout(text, uuid)                        from public, anon, authenticated;
revoke all on function public.cleanup_seats()                                 from public, anon, authenticated;
grant execute on function public.seat_buyin(text, uuid, bigint)               to service_role;
grant execute on function public.seat_settle(text, text, uuid[], int[], int)  to service_role;
grant execute on function public.seat_cashout(text, uuid)                     to service_role;
grant execute on function public.cleanup_seats()                              to service_role;

revoke all on public.cash_seats       from anon, authenticated;
revoke all on public.cash_seat_rounds from anon, authenticated;
