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
