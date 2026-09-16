-- Buy Box Bandit shipment tracking extension.
-- Safe to run more than once after supabase/order-ledger.sql.

alter table public.purchase_orders
  add column if not exists tracking_provider text,
  add column if not exists tracking_provider_id text,
  add column if not exists tracking_status text not null default 'not_tracked',
  add column if not exists tracking_status_detail text,
  add column if not exists tracking_last_event text,
  add column if not exists tracking_last_checked_at timestamptz,
  add column if not exists tracking_updated_at timestamptz,
  add column if not exists tracking_events jsonb not null default '[]'::jsonb;

create index if not exists purchase_orders_tracking_queue_idx
on public.purchase_orders (tracking_status, tracking_last_checked_at)
where tracking_number is not null and tracking_number <> '';

create unique index if not exists purchase_orders_tracking_provider_id_unique
on public.purchase_orders (tracking_provider, tracking_provider_id)
where tracking_provider_id is not null and tracking_provider_id <> '';

comment on column public.purchase_orders.tracking_provider_id is
  'Server-side carrier-tracking provider object ID; never expose provider credentials.';

-- A separate Google OAuth grant is required for unattended Gmail checks. Only
-- an AES-GCM encrypted refresh token is persisted; the browser never receives it.
create table if not exists public.gmail_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connected_by uuid references auth.users(id) on delete set null,
  google_email text not null,
  encrypted_refresh_token text not null,
  granted_scopes text[] not null default '{}'::text[],
  is_active boolean not null default true,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

alter table public.gmail_connections enable row level security;

drop policy if exists "gmail connections select own organization" on public.gmail_connections;
create policy "gmail connections select own organization"
on public.gmail_connections for select to authenticated
using (public.is_organization_member(organization_id));

-- OAuth token writes are server-only through the service role. Members can see
-- connection metadata through the API, which never selects the encrypted token.
revoke all on public.gmail_connections from anon, authenticated;
grant select (id, organization_id, google_email, is_active, last_checked_at, last_error, created_at, updated_at)
on public.gmail_connections to authenticated;

create index if not exists gmail_connections_daily_queue_idx
on public.gmail_connections (is_active, last_checked_at);
