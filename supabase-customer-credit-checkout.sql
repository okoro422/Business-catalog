begin;

alter table public.customer_credit_accounts
  add column if not exists repayment_days integer not null default 30;

alter table public.customer_credit_accounts
  drop constraint if exists customer_credit_accounts_repayment_days_check;
alter table public.customer_credit_accounts
  add constraint customer_credit_accounts_repayment_days_check
  check (repayment_days between 1 and 365);

alter table public.customer_credit_ledger
  add column if not exists due_at date;

alter table public.orders
  add column if not exists credit_due_at date;

alter table public.orders
  drop constraint if exists orders_payment_method_check;
alter table public.orders
  add constraint orders_payment_method_check
  check (payment_method in ('online', 'cash', 'transfer', 'credit'));

drop policy if exists "customers read own credit account" on public.customer_credit_accounts;
create policy "customers read own credit account"
  on public.customer_credit_accounts for select to authenticated
  using (customer_id = auth.uid());

drop policy if exists "customers read own credit ledger" on public.customer_credit_ledger;
create policy "customers read own credit ledger"
  on public.customer_credit_ledger for select to authenticated
  using (customer_id = auth.uid());

grant select on public.customer_credit_accounts to authenticated;
grant select on public.customer_credit_ledger to authenticated;

create or replace function public.staff_manage_customer_credit(
  p_customer_id uuid,
  p_credit_limit numeric,
  p_enabled boolean,
  p_repayment_days integer
) returns void
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
  if p_repayment_days is null or p_repayment_days not between 1 and 365 then
    raise exception 'Repayment term must be between 1 and 365 days';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_customer_id and role in ('customer', 'wholesale')
  ) then
    raise exception 'Customer not found';
  end if;

  insert into public.customer_credit_accounts (
    customer_id, credit_limit, enabled, repayment_days, updated_at, updated_by
  )
  values (
    p_customer_id, p_credit_limit, p_enabled, p_repayment_days, now(), auth.uid()
  )
  on conflict (customer_id) do update
    set credit_limit = excluded.credit_limit,
        enabled = excluded.enabled,
        repayment_days = excluded.repayment_days,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;
end;
$$;

create or replace function public.place_order(
  p_name text,
  p_phone text,
  p_zone text,
  p_area text,
  p_street text,
  p_landmark text,
  p_method text,
  p_items jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_sub numeric := 0;
  v_fee numeric;
  v_total numeric;
  v_zone public.delivery_zones%rowtype;
  v_credit public.customer_credit_accounts%rowtype;
  v_item jsonb;
  v_prod public.products%rowtype;
  v_price numeric;
  v_qty integer;
  v_mode text;
  v_due_at date;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null
    or nullif(trim(coalesce(p_phone, '')), '') is null then
    raise exception 'BAD_DETAILS';
  end if;
  if p_method is null or p_method not in ('online', 'cash', 'transfer', 'credit') then
    raise exception 'BAD_DETAILS';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  if p_method = 'credit' then
    select * into v_credit
    from public.customer_credit_accounts
    where customer_id = auth.uid()
    for update;
    if not found then
      raise exception 'CREDIT_NOT_ENABLED: No credit account is set up for your account.';
    end if;
    if not v_credit.enabled then
      raise exception 'CREDIT_NOT_ENABLED: Credit is not enabled for your account.';
    end if;
  end if;

  select * into v_zone
  from public.delivery_zones
  where code = p_zone and active;
  if not found then
    raise exception 'INVALID_ZONE';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if coalesce(v_item->>'product_id', '') = ''
      or coalesce(v_item->>'qty', '') !~ '^[0-9]+$' then
      raise exception 'BAD_ITEM';
    end if;
    v_qty := (v_item->>'qty')::integer;
    if v_qty < 1 then raise exception 'BAD_QTY'; end if;
    v_mode := coalesce(v_item->>'mode', 'single');
    if v_mode not in ('single', 'wholesale') then raise exception 'BAD_ITEM'; end if;
  end loop;

  v_id := 'BC-' || nextval('public.order_seq');
  insert into public.orders (
    id, user_id, customer_name, phone, zone_code, area, street, landmark,
    payment_method, subtotal, delivery_fee, total
  )
  values (
    v_id, auth.uid(), trim(p_name), trim(p_phone), p_zone, p_area, p_street,
    p_landmark, p_method, 0, 0, 0
  );

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'qty')::integer;
    v_mode := coalesce(v_item->>'mode', 'single');
    select * into v_prod
    from public.products
    where id = v_item->>'product_id' and status = 'active'
    for update;
    if not found then raise exception 'UNAVAILABLE'; end if;
    if v_prod.stock < v_qty then
      raise exception 'OUT_OF_STOCK: %', v_prod.name;
    end if;

    v_price := v_prod.price;
    if v_mode = 'wholesale' then
      v_price := coalesce(
        (
          select tier.price
          from public.product_tiers as tier
          where tier.product_id = v_prod.id and tier.min_qty <= v_qty
          order by tier.min_qty desc
          limit 1
        ),
        v_prod.price
      );
    end if;

    insert into public.order_items (
      order_id, product_id, name, qty, unit_price, line_total
    )
    values (
      v_id, v_prod.id,
      v_prod.name || case when v_mode = 'wholesale' then ' · wholesale' else '' end,
      v_qty, v_price, v_price * v_qty
    );
    v_sub := v_sub + v_price * v_qty;
    update public.products set stock = stock - v_qty where id = v_prod.id;
  end loop;

  v_fee := case
    when v_zone.free_over is not null and v_sub >= v_zone.free_over then 0
    else v_zone.fee
  end;
  v_total := v_sub + v_fee;

  if p_method = 'credit' then
    if v_credit.balance + v_total > v_credit.credit_limit then
      raise exception 'CREDIT_LIMIT_EXCEEDED: This order exceeds your available credit of ₦%.', to_char(v_credit.credit_limit - v_credit.balance, 'FM999,999,999,990.00');
    end if;
    v_due_at := (now() at time zone 'Africa/Lagos')::date + v_credit.repayment_days;

    update public.customer_credit_accounts
    set balance = balance + v_total,
        updated_at = now(),
        updated_by = auth.uid()
    where customer_id = auth.uid();

    insert into public.customer_credit_ledger (
      customer_id, order_id, entry_type, amount, balance_after,
      description, created_by, due_at
    )
    values (
      auth.uid(), v_id, 'charge', v_total, v_credit.balance + v_total,
      'Credit order ' || v_id, auth.uid(), v_due_at
    );
  end if;

  update public.orders
  set subtotal = v_sub,
      delivery_fee = v_fee,
      total = v_total,
      payment_status = case when p_method = 'credit' then 'credit_due' else payment_status end,
      credit_due_at = v_due_at
  where id = v_id;

  return v_id;
end;
$$;

revoke all on function public.staff_manage_customer_credit(uuid, numeric, boolean, integer) from public;
revoke all on function public.place_order(text, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.staff_manage_customer_credit(uuid, numeric, boolean, integer) to authenticated;
grant execute on function public.place_order(text, text, text, text, text, text, text, jsonb) to authenticated;

commit;
