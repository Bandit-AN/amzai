create extension if not exists pgcrypto;

create table if not exists public.student_storefronts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  airtable_student_id text,
  owner_email text not null,
  seller_id text not null check (seller_id ~ '^[A-Z0-9]{6,32}$'),
  label text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, seller_id)
);

-- Safe migration for projects that ran the earlier portal-only schema.
alter table public.student_storefronts alter column user_id drop not null;
alter table public.student_storefronts drop constraint if exists student_storefronts_user_id_fkey;
alter table public.student_storefronts add constraint student_storefronts_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
alter table public.student_storefronts add column if not exists airtable_student_id text;
create unique index if not exists student_storefronts_airtable_seller_unique
on public.student_storefronts (airtable_student_id, seller_id)
where airtable_student_id is not null;

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
