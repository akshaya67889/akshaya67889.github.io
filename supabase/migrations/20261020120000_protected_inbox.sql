create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists public.inbox_connections (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  gmail_email text not null, encrypted_refresh_token text not null, token_nonce text not null,
  status text not null default 'connected' check (status in ('connected','reauthorization_required','error','disconnected')),
  last_synced_at timestamptz, history_id text, sync_cursor text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id), unique(gmail_email)
);
create index if not exists inbox_connections_owner_idx on public.inbox_connections(owner_id);
create table if not exists public.inbox_sources (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  email citext not null, route_address citext not null, status text not null default 'pending' check (status in ('pending','verified','disabled')),
  verification_method text check (verification_method in ('gmail_route_test','signed_gateway')), verification_challenge text not null,
  verification_message_id text, verified_at timestamptz, created_at timestamptz not null default now(), unique(owner_id,email), unique(owner_id,route_address)
);
create index if not exists inbox_sources_owner_idx on public.inbox_sources(owner_id);
create table if not exists public.inbox_messages (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  gmail_message_id text not null, gmail_thread_id text, source_id uuid references public.inbox_sources(id) on delete set null,
  source_identity_status text not null default 'unknown' check (source_identity_status in ('verified','unknown','manual_unverified')),
  original_from text, subject text, received_at timestamptz, text_body text, html_body text, attachments jsonb not null default '[]'::jsonb,
  headers jsonb not null default '{}'::jsonb, is_read boolean not null default false, imported_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id,gmail_message_id)
);
create index if not exists inbox_messages_owner_received_idx on public.inbox_messages(owner_id,received_at desc nulls last,id desc);
create index if not exists inbox_messages_owner_source_idx on public.inbox_messages(owner_id,source_id);
create index if not exists inbox_messages_gmail_idx on public.inbox_messages(owner_id,gmail_message_id);
create table if not exists public.inbox_sync_checkpoints (
  owner_id uuid primary key references auth.users(id) on delete cascade, page_token text, history_id text,
  mode text not null default 'backfill' check (mode in ('backfill','history','idle')), locked_until timestamptz,
  pending_ids jsonb not null default '[]'::jsonb, pending_next_page text, pending_history_id text,
  lease_token text, attempts integer not null default 0, next_run_at timestamptz not null default now(), last_error_code text, updated_at timestamptz not null default now()
);
alter table public.inbox_sync_checkpoints add column if not exists lease_token text;

create table if not exists public.inbox_errors (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  operation text not null, code text not null, message text not null, retryable boolean not null default false, attempts integer not null default 0, resolved_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists inbox_errors_owner_created_idx on public.inbox_errors(owner_id,created_at desc);
create table if not exists public.inbox_oauth_states (id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, state_hash text not null unique, expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now());
create table if not exists public.inbox_tombstones (owner_id uuid not null references auth.users(id) on delete cascade, gmail_message_id text not null, deleted_at timestamptz not null default now(), primary key(owner_id,gmail_message_id));

alter table public.inbox_connections enable row level security;
alter table public.inbox_sources enable row level security;
alter table public.inbox_messages enable row level security;
alter table public.inbox_sync_checkpoints enable row level security;
alter table public.inbox_errors enable row level security;
alter table public.inbox_oauth_states enable row level security;
alter table public.inbox_tombstones enable row level security;
do $$ begin
  create policy inbox_connections_select_owner on public.inbox_connections for select using (owner_id = auth.uid());
  create policy inbox_sources_select_owner on public.inbox_sources for select using (owner_id = auth.uid());
  create policy inbox_messages_select_owner on public.inbox_messages for select using (owner_id = auth.uid());
  create policy inbox_checkpoints_select_owner on public.inbox_sync_checkpoints for select using (owner_id = auth.uid());
  create policy inbox_errors_select_owner on public.inbox_errors for select using (owner_id = auth.uid());
exception when duplicate_object then null; end $$;
revoke all on public.inbox_connections, public.inbox_sources, public.inbox_messages, public.inbox_sync_checkpoints, public.inbox_errors, public.inbox_oauth_states, public.inbox_tombstones from public, anon, authenticated;
alter table public.inbox_sources add constraint inbox_sources_owner_id_id_unique unique(owner_id,id);
do $$ begin
  alter table public.inbox_messages add constraint inbox_messages_owner_source_fk foreign key (owner_id, source_id) references public.inbox_sources(owner_id, id);
exception when duplicate_object then null; end $$;

drop function if exists public.inbox_acquire_sync_lock(uuid,integer);
create or replace function public.inbox_acquire_sync_lock(p_owner_id uuid, p_lease_seconds integer default 120)
returns text language plpgsql security definer set search_path = public as $$
declare token text := gen_random_uuid()::text; claimed integer;
begin
  insert into inbox_sync_checkpoints(owner_id, lease_token, locked_until, next_run_at) values (p_owner_id, token, now() + make_interval(secs => least(greatest(p_lease_seconds,30),120)), now())
  on conflict (owner_id) do update set lease_token=token, locked_until=now() + make_interval(secs => least(greatest(p_lease_seconds,30),120)), updated_at=now()
  where inbox_sync_checkpoints.locked_until is null or inbox_sync_checkpoints.locked_until <= now();
  get diagnostics claimed = row_count; if claimed <> 1 then return null; end if; return token;
end $$;
drop function if exists public.inbox_release_sync_lock(uuid);
create or replace function public.inbox_release_sync_lock(p_owner_id uuid, p_lease_token text)
returns void language sql security definer set search_path = public as $$
  update inbox_sync_checkpoints set locked_until=null, lease_token=null, updated_at=now() where owner_id=p_owner_id and lease_token=p_lease_token;
$$;
create or replace function public.inbox_consume_oauth_state(p_state_hash text)
returns public.inbox_oauth_states language plpgsql security definer set search_path = public as $$
declare result inbox_oauth_states;
begin update inbox_oauth_states set consumed_at=now() where state_hash=p_state_hash and consumed_at is null and expires_at>now() returning * into result; return result; end $$;
revoke all on function public.inbox_acquire_sync_lock(uuid,integer), public.inbox_release_sync_lock(uuid,text), public.inbox_consume_oauth_state(text) from public, anon, authenticated;
grant execute on function public.inbox_acquire_sync_lock(uuid,integer), public.inbox_release_sync_lock(uuid,text), public.inbox_consume_oauth_state(text) to service_role;

create or replace function public.inbox_purge_owner(p_owner_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into inbox_tombstones(owner_id,gmail_message_id) select owner_id,gmail_message_id from inbox_messages where owner_id=p_owner_id on conflict (owner_id,gmail_message_id) do nothing;
  update inbox_connections set status='disconnected', encrypted_refresh_token='purged', token_nonce='purged', history_id=null where owner_id=p_owner_id;
  delete from inbox_messages where owner_id=p_owner_id;
  delete from inbox_sync_checkpoints where owner_id=p_owner_id;
end $$;
revoke all on function public.inbox_purge_owner(uuid) from public, anon, authenticated;
grant execute on function public.inbox_purge_owner(uuid) to service_role;
