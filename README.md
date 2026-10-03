# 써틴 트레이너 — 웹사이트 배포

GitHub Pages(사이트) + Supabase(로그인·리더보드) 조합입니다.
Supabase를 설정하지 않아도 게임과 힌트는 그대로 동작하고, 기록만 브라우저에 남습니다.

```
site/
  index.html    화면
  engine.js     게임 규칙 + ISMCTS + 신경망 추론
  worker.js     AI 계산 전용 스레드
  app.js        게임 진행과 화면 갱신
  auth.js       로그인과 리더보드
  config.js     ← Supabase 주소/키를 여기에 적습니다
  weights.bin   (선택) 학습한 모델. 두면 접속하자마자 이 모델을 씁니다
```

## 1. GitHub Pages로 사이트 띄우기

1. 이 `site` 폴더의 파일들을 저장소에 넣고 푸시합니다. 저장소 루트에 두거나 `docs/` 폴더에 두세요.
2. 저장소 → **Settings → Pages**
3. **Source**를 `Deploy from a branch`, 브랜치를 `main`, 폴더를 `/ (root)` 또는 `/docs`로 지정하고 저장합니다.
4. 1~2분 뒤 `https://<아이디>.github.io/<저장소이름>/` 에서 열립니다.

저장소가 비공개면 Pages도 비공개(유료 플랜)라서, 공개 사이트로 쓰려면 저장소를 public으로 바꿔야 합니다.

모델을 같이 올리려면 `models_pts/gen0/weights.bin`을 `site/weights.bin`으로 복사해 두세요.
올리지 않으면 방문자가 설정에서 직접 파일을 선택할 수 있고, 아무것도 없으면 기본 ISMCTS로 동작합니다.
**사이트에 올린 weights.bin은 누구나 내려받을 수 있습니다.**

## 2. Supabase로 로그인과 리더보드 붙이기

### 2-1. 프로젝트 만들기

1. <https://supabase.com> 가입 후 **New project** 생성 (Region은 `Northeast Asia (Seoul)` 권장)
2. **Project Settings → API** 에서 두 값을 복사합니다.
   - `Project URL`
   - `anon` `public` 키
3. `config.js`에 붙여 넣습니다.

```js
window.THIRTEEN_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  MODEL_URL: 'weights.bin',
};
```

anon 키는 공개되어도 되는 값입니다. 실제 보호는 아래 RLS 규칙이 합니다.
`service_role` 키는 절대 사이트에 넣지 마세요.

### 2-2. 이메일 확인 끄기

이 사이트는 아이디를 내부적으로 `아이디@thirteen.local` 주소로 바꿔서 Supabase에 전달합니다.
실제로 메일을 보낼 수 없으므로 확인 절차를 꺼야 합니다.

**Authentication → Sign In / Providers → Email** 에서 **Confirm email**을 끕니다.

### 2-3. 테이블과 보안 규칙 만들기

**SQL Editor**에서 아래를 그대로 실행하세요.

```sql
create table public.profiles (
  id       uuid primary key references auth.users on delete cascade,
  username text not null,
  total    integer not null default 0,
  games    integer not null default 0,
  wins     integer not null default 0,
  updated  timestamptz not null default now()
);

create unique index profiles_username_key on public.profiles (lower(username));

alter table public.profiles enable row level security;

-- 리더보드: 누구나 읽기
create policy "read all" on public.profiles
  for select using (true);

-- 자기 기록만 쓰기
create policy "insert own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
```

이 규칙 때문에 다른 사람의 점수는 아무도 고칠 수 없습니다.

## 2-4. 코인과 캐시 게임

1. **SQL Editor**에서 `coins.sql`을 실행합니다. (지갑, 장부, 관리자 함수)
2. 이어서 `cash_session.sql`을 실행합니다. (캐시 게임 세션 바이인)
3. 이어서 `ai_cash.sql`을 실행합니다. (AI 와 하는 캐시 게임)
   이어서 `tour.sql`을 실행합니다. (매일 코인 · 주간 대회 · 승리 순위 · 주간 상금)
   Database → Extensions 에서 `pg_cron`을 켜 두면 상금이 일요일 밤 자정(한국 시간)에 바로 지급되고,
   켜지 않으면 그 뒤 처음 누군가 대회 탭을 열 때 지급됩니다. pg_cron 을 나중에 켰다면 `tour.sql`을 한 번 더 실행하세요.
4. `index.ts`를 Edge Function `thirteen`으로 다시 배포합니다.
   AI 캐시 게임의 AI 는 서버에서 `https://thirteen.kr/weights.bin` 을 받아 씁니다.
   주소가 다르면 Edge Function 의 Secrets 에 `MODEL_URL` 을 넣어 주세요.

캐시 게임은 **방에 들어올 때 바이인을 한 번 묶고, 방을 나갈 때 남은 만큼 돌려줍니다.**
판이 끝날 때마다 묶인 코인 안에서 주고받으므로, 바이인보다 적게 남아도 계속 할 수 있어요.
한 판에 잃는 금액은 그 사람에게 남은 바이인까지이고, 다 잃으면 관전으로 바뀝니다.
모든 참가자의 남은 바이인은 방 화면과 점수표에 보입니다.
묶인 코인은 코인 화면의 '묶임'에 나오고, 12시간 넘게 버려진 방의 코인은 다음에 방을 만들 때 자동으로 돌려줍니다.

## 3. 로컬에서 확인하기

`file://`로 열면 워커와 모델 로드가 막히므로, 간단한 서버를 띄워서 확인하세요.

```
cd site
python -m http.server 8000
```

브라우저에서 <http://localhost:8000> 을 엽니다.

## 자주 겪는 문제

- **화면은 뜨는데 AI가 두지 않아요** — `worker.js`, `engine.js`가 `index.html`과 같은 폴더에 있는지 확인하세요.
- **로그인에서 "Email not confirmed"** — 2-2의 Confirm email이 아직 켜져 있습니다.
- **리더보드가 비어 있어요** — 2-3의 SQL을 실행했는지, `config.js`의 두 값이 맞는지 확인하세요.
- **Pages 주소가 404** — 배포에 1~2분 걸립니다. `index.html`이 지정한 폴더의 최상위에 있어야 합니다.

## 점수를 지우고 싶을 때

Supabase의 **Table Editor → profiles**에서 행을 지우면 됩니다.
