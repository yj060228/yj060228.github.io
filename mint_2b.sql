-- ════════════════════════════════════════════════════════════════════
-- 코인 추가 발행: 20억 코인을 관리자 계정에 더 넣어 총 발행량을 21억으로
--
-- coins.sql 을 실행해 둔 상태에서 SQL Editor 에 통째로 붙여넣고 Run 하세요.
--   · 받는 계정: 처음 1억을 발행받은 관리자 계정 (AI 캐시 게임 · 상금 · 매일 코인이 나가는 그 지갑)
--   · 장부에 'genesis'(발행)로 남겨서, 코인 현황의 '발행량'이 21억으로 보이고 총량 점검(coin_audit)도 맞습니다.
--   · 한 번만 발행됩니다. 여러 번 실행해도 다시 발행하지 않아요.
-- ════════════════════════════════════════════════════════════════════

do $$
declare
  v_admin  uuid;
  v_issued bigint;
  v_add    constant bigint := 2000000000;          -- 20억
begin
  if exists (select 1 from coin_ledger where ref = 'genesis:2') then
    raise notice '이미 20억을 추가 발행했어요. 다시 발행하지 않았습니다.';
    return;
  end if;

  -- 처음 1억을 받은 계정. 없으면 가장 먼저 등록된 관리자
  select to_user into v_admin from coin_ledger where reason = 'genesis' order by id limit 1;
  if v_admin is null then
    select user_id into v_admin from admins order by created_at limit 1;
  end if;
  if v_admin is null then
    raise exception '관리자 계정이 없어요. 먼저 select admin_setup(''내아이디''); 를 실행해 주세요.';
  end if;

  select coalesce(sum(amount), 0) into v_issued from coin_ledger where reason = 'genesis';

  insert into wallets(user_id) values (v_admin) on conflict (user_id) do nothing;
  update wallets set balance = balance + v_add, updated_at = now() where user_id = v_admin;
  insert into coin_ledger(from_user, to_user, amount, reason, ref, memo)
    values (null, v_admin, v_add, 'genesis', 'genesis:2', '추가 발행 (총 21억)');

  raise notice '관리자 계정에 20억 코인을 추가 발행했어요. 총 발행량: % → %', v_issued, v_issued + v_add;
end $$;

-- 확인: issued 가 2,100,000,000 이고 ok 가 true 면 끝
select * from coin_audit();
