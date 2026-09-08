create extension if not exists pgcrypto;

create table if not exists public.student_storefronts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner_email text not null,
  seller_id text not null check (seller_id ~ '^[A-Z0-9]{6,32}$'),
  label text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, seller_id)
);

alter table public.student_storefronts enable row level security;

drop policy if exists "students read own storefronts" on public.student_storefronts;
create policy "students read own storefronts"
on public.student_storefronts for select
using (auth.uid() = user_id);

drop policy if exists "students add own storefronts" on public.student_storefronts;
create policy "students add own storefronts"
on public.student_storefronts for insert
with check (
  auth.uid() = user_id
  and lower(owner_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "students update own storefronts" on public.student_storefronts;
create policy "students update own storefronts"
on public.student_storefronts for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and lower(owner_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "students remove own storefronts" on public.student_storefronts;
create policy "students remove own storefronts"
on public.student_storefronts for delete
using (auth.uid() = user_id);

create index if not exists student_storefronts_owner_email_idx
on public.student_storefronts (lower(owner_email));
