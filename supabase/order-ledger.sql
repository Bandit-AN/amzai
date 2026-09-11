-- Buy Box Bandit purchase-capture ledger.
-- Run this entire file once in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  plan text not null default 'capture' check (plan in ('capture', 'intelligence', 'operations')),
  entitlements jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = target_organization_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_organization_manager(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

create table if not exists public.payment_card_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  last_four text check (last_four is null or last_four ~ '^[0-9]{4}$'),
  issuer text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, label),
  unique (id, organization_id)
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  source_retailer text not null,
  source_url text,
  retailer_order_number text,
  ordered_at timestamptz not null default now(),
  status text not null default 'ordered'
    check (status in ('draft', 'ordered', 'partially_shipped', 'shipped', 'partially_delivered', 'delivered', 'cancelled', 'returned')),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  subtotal numeric(12,2) check (subtotal is null or subtotal >= 0),
  tax numeric(12,2) not null default 0 check (tax >= 0),
  shipping numeric(12,2) not null default 0 check (shipping >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  total numeric(12,2) check (total is null or total >= 0),
  card_alias_id uuid,
  receiving_location text,
  invoice_reference text,
  tracking_number text,
  carrier text,
  expected_delivery_at timestamptz,
  notes text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (card_alias_id, organization_id)
    references public.payment_card_aliases(id, organization_id)
);

create unique index if not exists purchase_orders_retailer_number_unique
on public.purchase_orders (organization_id, lower(source_retailer), retailer_order_number)
where retailer_order_number is not null and retailer_order_number <> '';

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null,
  product_title text not null,
  retailer_sku text,
  variant text,
  quantity numeric(10,2) not null check (quantity > 0),
  unit_cost numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  line_total numeric(12,2) check (line_total is null or line_total >= 0),
  asin text check (asin is null or asin ~ '^B[A-Z0-9]{9}$'),
  amazon_url text,
  amazon_title text,
  seller_central_status text not null default 'not_checked'
    check (seller_central_status in ('not_checked', 'eligible', 'approval_required', 'restricted', 'listed')),
  is_bundle boolean not null default false,
  prep_sheet_complete boolean not null default false,
  received_quantity numeric(10,2) not null default 0 check (received_quantity >= 0),
  extraction_confidence numeric(5,4) check (extraction_confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (purchase_order_id, organization_id)
    references public.purchase_orders(id, organization_id) on delete cascade
);

create index if not exists purchase_order_items_order_idx
on public.purchase_order_items (purchase_order_id);
create index if not exists purchase_order_items_asin_idx
on public.purchase_order_items (organization_id, asin);

create table if not exists public.capture_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'source_captured'
    check (status in ('source_captured', 'amazon_linked', 'confirmed', 'cancelled', 'expired')),
  source_page_url text,
  amazon_page_url text,
  source_capture jsonb not null default '{}'::jsonb,
  amazon_capture jsonb not null default '{}'::jsonb,
  source_image_path text,
  amazon_image_path text,
  purchase_order_id uuid,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (purchase_order_id, organization_id)
    references public.purchase_orders(id, organization_id) on delete cascade
);

create index if not exists capture_sessions_open_idx
on public.capture_sessions (organization_id, created_by, created_at desc)
where status in ('source_captured', 'amazon_linked');

create table if not exists public.google_sheet_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connected_by uuid references auth.users(id) on delete set null,
  spreadsheet_id text not null,
  spreadsheet_title text not null,
  order_tracking_tab text not null default 'Order Tracking',
  expenses_tab text not null default 'Automated Order Expenses',
  backend_tab text not null default 'Backend',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, spreadsheet_id),
  unique (id, organization_id)
);

-- OAuth refresh tokens are intentionally not stored in this table. They must
-- be encrypted by the server and kept in a dedicated secret store.
create table if not exists public.google_sheet_sync_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  purchase_order_id uuid,
  purchase_order_item_id uuid,
  target_tab text not null,
  target_row integer check (target_row is null or target_row > 0),
  status text not null default 'pending' check (status in ('pending', 'synced', 'failed')),
  error_message text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, organization_id)
    references public.google_sheet_connections(id, organization_id) on delete cascade,
  foreign key (purchase_order_id, organization_id)
    references public.purchase_orders(id, organization_id) on delete cascade,
  foreign key (purchase_order_item_id, organization_id)
    references public.purchase_order_items(id, organization_id) on delete cascade
);

create unique index if not exists google_sheet_sync_records_target_unique
on public.google_sheet_sync_records (
  connection_id,
  coalesce(purchase_order_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(purchase_order_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
  target_tab
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'organizations', 'payment_card_aliases', 'purchase_orders',
    'purchase_order_items', 'capture_sessions', 'google_sheet_connections',
    'google_sheet_sync_records'
  ] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', table_name);
    execute format(
      'create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',
      table_name
    );
  end loop;
end $$;

-- Give every existing and future authenticated user a personal organization.
create or replace function public.create_personal_organization_for_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare personal_organization_id uuid;
begin
  insert into public.organizations (name, created_by)
  values (coalesce(new.raw_user_meta_data ->> 'full_name', new.email, 'My business'), new.id)
  returning id into personal_organization_id;
  insert into public.organization_members (organization_id, user_id, role)
  values (personal_organization_id, new.id, 'owner');
  return new;
end;
$$;

drop trigger if exists create_personal_organization_after_signup on auth.users;
create trigger create_personal_organization_after_signup
after insert on auth.users
for each row execute function public.create_personal_organization_for_user();

do $$
declare
  existing_user record;
  personal_organization_id uuid;
begin
  for existing_user in
    select id, email, raw_user_meta_data from auth.users user_row
    where not exists (
      select 1 from public.organization_members member_row where member_row.user_id = user_row.id
    )
  loop
    insert into public.organizations (name, created_by)
    values (
      coalesce(existing_user.raw_user_meta_data ->> 'full_name', existing_user.email, 'My business'),
      existing_user.id
    ) returning id into personal_organization_id;
    insert into public.organization_members (organization_id, user_id, role)
    values (personal_organization_id, existing_user.id, 'owner');
  end loop;
end $$;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.payment_card_aliases enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.capture_sessions enable row level security;
alter table public.google_sheet_connections enable row level security;
alter table public.google_sheet_sync_records enable row level security;

drop policy if exists "members read organizations" on public.organizations;
create policy "members read organizations" on public.organizations for select
using (public.is_organization_member(id));

drop policy if exists "managers update organizations" on public.organizations;
create policy "managers update organizations" on public.organizations for update
using (public.is_organization_manager(id))
with check (public.is_organization_manager(id));

drop policy if exists "members read organization roster" on public.organization_members;
create policy "members read organization roster" on public.organization_members for select
using (public.is_organization_member(organization_id));

drop policy if exists "managers manage organization roster" on public.organization_members;
create policy "managers manage organization roster" on public.organization_members for all
using (public.is_organization_manager(organization_id))
with check (public.is_organization_manager(organization_id));

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'payment_card_aliases', 'purchase_orders', 'purchase_order_items',
    'capture_sessions', 'google_sheet_connections', 'google_sheet_sync_records'
  ] loop
    execute format('drop policy if exists "members read own organization" on public.%I', table_name);
    execute format(
      'create policy "members read own organization" on public.%I for select using (public.is_organization_member(organization_id))',
      table_name
    );
    execute format('drop policy if exists "members create in own organization" on public.%I', table_name);
    execute format(
      'create policy "members create in own organization" on public.%I for insert with check (public.is_organization_member(organization_id))',
      table_name
    );
    execute format('drop policy if exists "members update own organization" on public.%I', table_name);
    execute format(
      'create policy "members update own organization" on public.%I for update using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id))',
      table_name
    );
    execute format('drop policy if exists "managers delete from organization" on public.%I', table_name);
    execute format(
      'create policy "managers delete from organization" on public.%I for delete using (public.is_organization_manager(organization_id))',
      table_name
    );
  end loop;
end $$;

grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.is_organization_manager(uuid) to authenticated;
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select, insert, update, delete on public.payment_card_aliases to authenticated;
grant select, insert, update, delete on public.purchase_orders to authenticated;
grant select, insert, update, delete on public.purchase_order_items to authenticated;
grant select, insert, update, delete on public.capture_sessions to authenticated;
grant select, insert, update, delete on public.google_sheet_connections to authenticated;
grant select, insert, update, delete on public.google_sheet_sync_records to authenticated;
