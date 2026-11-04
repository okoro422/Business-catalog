-- Add the customer credit ledger, supplier invoice uploads, quote conversion,
-- and optional supplier invoice attachments to an existing Business Catalog
-- Supabase project. Run in Supabase > SQL Editor after supabase-schema.txt.

create table if not exists public.customer_credit_accounts (
  customer_id uuid primary key references public.profiles(id) on delete cascade,
  credit_limit numeric(12,2) not null default 0 check (credit_limit >= 0),
  balance numeric(12,2) not null default 0 check (balance >= 0),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

create table if not exists public.customer_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  order_id text references public.orders(id) on delete set null,
  entry_type text not null check (entry_type in ('charge', 'payment')),
  amount numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2) not null check (balance_after >= 0),
  description text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.supply_requests
  add column if not exists converted_order_id text references public.orders(id) on delete set null;

alter table public.orders
  add column if not exists discount numeric(12,2) not null default 0 check (discount >= 0);

create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null,
  storage_path text not null unique,
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  file_size bigint not null check (file_size > 0),
  supplier_name text,
  invoice_number text,
  invoice_date date,
  due_date date,
  currency text not null default 'NGN',
  subtotal numeric(12,2),
  tax numeric(12,2),
  total numeric(12,2),
  status text not null default 'queued' check (status in ('queued', 'processing', 'processed', 'failed')),
  extracted_data jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supply_request_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id text not null references public.supply_requests(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null,
  storage_path text not null unique,
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  file_size bigint not null check (file_size > 0),
  created_at timestamptz not null default now()
);

alter table public.customer_credit_accounts enable row level security;
alter table public.customer_credit_ledger enable row level security;
alter table public.supplier_invoices enable row level security;
alter table public.supply_request_attachments enable row level security;

drop policy if exists "staff manage customer credit accounts" on public.customer_credit_accounts;
drop policy if exists "staff read customer credit accounts" on public.customer_credit_accounts;
create policy "staff read customer credit accounts"
  on public.customer_credit_accounts for select using (public.is_staff());

drop policy if exists "staff read customer credit ledger" on public.customer_credit_ledger;
create policy "staff read customer credit ledger"
  on public.customer_credit_ledger for select using (public.is_staff());

drop policy if exists "staff read supplier invoices" on public.supplier_invoices;
create policy "staff read supplier invoices"
  on public.supplier_invoices for select using (public.is_staff());
drop policy if exists "staff add supplier invoices" on public.supplier_invoices;
create policy "staff add supplier invoices"
  on public.supplier_invoices for insert
  with check (public.is_staff() and uploaded_by = auth.uid());
drop policy if exists "staff update supplier invoices" on public.supplier_invoices;
create policy "staff update supplier invoices"
  on public.supplier_invoices for update
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "read own or staff supply attachments" on public.supply_request_attachments;
create policy "read own or staff supply attachments"
  on public.supply_request_attachments for select
  using (
    public.is_staff()
    or exists (
      select 1 from public.supply_requests r
      where r.id = request_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "add own supply attachments" on public.supply_request_attachments;
create policy "add own supply attachments"
  on public.supply_request_attachments for insert
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.supply_requests r
      where r.id = request_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "staff manage supply attachments" on public.supply_request_attachments;
create policy "staff manage supply attachments"
  on public.supply_request_attachments for all
  using (public.is_staff()) with check (public.is_staff());

grant select on public.customer_credit_accounts to authenticated;
grant select on public.customer_credit_ledger to authenticated;
grant select, insert, update on public.supplier_invoices to authenticated;
grant select, insert on public.supply_request_attachments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supplier-invoices',
  'supplier-invoices',
  false,
  15728640,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supply-request-files',
  'supply-request-files',
  false,
  15728640,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "staff read supplier invoice files" on storage.objects;
create policy "staff read supplier invoice files"
  on storage.objects for select to authenticated
  using (bucket_id = 'supplier-invoices' and public.is_staff());
drop policy if exists "staff upload supplier invoice files" on storage.objects;
create policy "staff upload supplier invoice files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'supplier-invoices' and public.is_staff());
drop policy if exists "staff delete supplier invoice files" on storage.objects;
create policy "staff delete supplier invoice files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'supplier-invoices' and public.is_staff());

drop policy if exists "customers read own supply files" on storage.objects;
create policy "customers read own supply files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'supply-request-files'
    and (public.is_staff() or (storage.foldername(name))[1] = auth.uid()::text)
  );
drop policy if exists "customers upload own supply files" on storage.objects;
create policy "customers upload own supply files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'supply-request-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "customers delete own supply files" on storage.objects;
create policy "customers delete own supply files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'supply-request-files'
    and (public.is_staff() or (storage.foldername(name))[1] = auth.uid()::text)
  );

create or replace function public.staff_manage_customer_credit(
  p_customer_id uuid,
  p_credit_limit numeric,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'Staff access required';
  end if;
  if p_credit_limit is null or p_credit_limit < 0 or p_enabled is null then
    raise exception 'Enter a valid credit limit and enabled state';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_customer_id and role in ('customer', 'wholesale')
  ) then
    raise exception 'Customer not found';
  end if;

  insert into public.customer_credit_accounts (
    customer_id, credit_limit, enabled, updated_at, updated_by
  )
  values (p_customer_id, p_credit_limit, p_enabled, now(), auth.uid())
  on conflict (customer_id) do update
    set credit_limit = excluded.credit_limit,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;
end;
$$;

create or replace function public.staff_adjust_credit_balance(
  p_customer_id uuid,
  p_delta numeric,
  p_description text,
  p_order_id text default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.customer_credit_accounts%rowtype;
  v_new_balance numeric(12,2);
begin
  if not public.is_staff() then
    raise exception 'Staff access required';
  end if;
  if p_delta is null or p_delta = 0 or nullif(trim(coalesce(p_description, '')), '') is null then
    raise exception 'Enter a non-zero amount and a reason';
  end if;

  select * into v_account
  from public.customer_credit_accounts
  where customer_id = p_customer_id
  for update;
  if not found then
    raise exception 'Set up this customer credit account first';
  end if;

  v_new_balance := v_account.balance + p_delta;
  if v_new_balance < 0 then
    raise exception 'Payment exceeds the outstanding balance';
  end if;
  if p_delta > 0 and not v_account.enabled then
    raise exception 'Enable this credit account before adding a charge';
  end if;
  if p_delta > 0 and v_new_balance > v_account.credit_limit then
    raise exception 'Charge would exceed the customer credit limit';
  end if;

  update public.customer_credit_accounts
  set balance = v_new_balance, updated_at = now(), updated_by = auth.uid()
  where customer_id = p_customer_id;

  insert into public.customer_credit_ledger (
    customer_id, order_id, entry_type, amount, balance_after, description, created_by
  )
  values (
    p_customer_id, p_order_id,
    case when p_delta > 0 then 'charge' else 'payment' end,
    abs(p_delta), v_new_balance, trim(p_description), auth.uid()
  );

  return v_new_balance;
end;
$$;

revoke all on function public.staff_manage_customer_credit(uuid, numeric, boolean) from public;
revoke all on function public.staff_adjust_credit_balance(uuid, numeric, text, text) from public;
grant execute on function public.staff_manage_customer_credit(uuid, numeric, boolean) to authenticated;
grant execute on function public.staff_adjust_credit_balance(uuid, numeric, text, text) to authenticated;

create or replace function public.convert_supply_quote_to_order(
  p_request_id text,
  p_method text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supply_requests%rowtype;
  v_id text;
  v_subtotal numeric(12,2);
  v_total numeric(12,2);
begin
  if auth.uid() is null then
    raise exception 'Sign in before converting a quote';
  end if;
  if p_method is null or p_method not in ('online', 'cash', 'transfer') then
    raise exception 'Choose a supported payment method';
  end if;

  select * into v_request
  from public.supply_requests
  where id = p_request_id and user_id = auth.uid()
  for update;
  if not found then
    raise exception 'Quote not found';
  end if;
  if v_request.converted_order_id is not null then
    return v_request.converted_order_id;
  end if;
  if v_request.status not in ('Quoted', 'Accepted') then
    raise exception 'This quote is not ready to convert';
  end if;
  if v_request.valid_until is not null and v_request.valid_until < current_date then
    raise exception 'This quote has expired';
  end if;
  if not exists (
    select 1 from public.delivery_zones
    where code = v_request.zone_code and active
  ) then
    raise exception 'The delivery zone is no longer available';
  end if;
  if not exists (
    select 1 from public.supply_request_items
    where request_id = p_request_id
  ) or exists (
    select 1 from public.supply_request_items
    where request_id = p_request_id and unit_price is null
  ) then
    raise exception 'The quote is missing item prices';
  end if;

  select coalesce(sum(qty * unit_price), 0)
  into v_subtotal
  from public.supply_request_items
  where request_id = p_request_id;
  v_total := greatest(0, v_subtotal - coalesce(v_request.discount, 0))
    + coalesce(v_request.delivery_fee, 0);
  v_id := 'BC-' || nextval('public.order_seq');

  insert into public.orders (
    id, user_id, customer_name, phone, zone_code, payment_method,
    subtotal, discount, delivery_fee, total, status
  )
  values (
    v_id, auth.uid(),
    coalesce(nullif(v_request.contact_person, ''), v_request.business_name),
    coalesce(v_request.phone, ''),
    v_request.zone_code, p_method, v_subtotal, coalesce(v_request.discount, 0),
    coalesce(v_request.delivery_fee, 0), v_total, 'Placed'
  );

  insert into public.order_items (order_id, product_id, name, qty, unit_price, line_total)
  select
    v_id,
    item.product_id,
    coalesce(product.name, item.custom_description, 'Custom item') || ' · ' || item.pack,
    item.qty,
    item.unit_price,
    item.qty * item.unit_price
  from public.supply_request_items item
  left join public.products product on product.id = item.product_id
  where item.request_id = p_request_id;

  update public.supply_requests
  set status = 'Accepted', converted_order_id = v_id
  where id = p_request_id;

  return v_id;
end;
$$;

revoke all on function public.convert_supply_quote_to_order(text, text) from public;
grant execute on function public.convert_supply_quote_to_order(text, text) to authenticated;
