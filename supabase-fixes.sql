-- Apply this migration to an existing Business Catalog Supabase project.
-- It is safe to run more than once.

alter table public.categories
  add column if not exists sort_order integer not null default 0;

alter table public.products
  add column if not exists description text,
  add column if not exists ingredients text,
  add column if not exists how_to_use text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, email, full_name, phone, business_name, business_type, tier
  )
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'business_name',
    new.raw_user_meta_data->>'business_type',
    case
      when new.raw_user_meta_data->>'account_type' = 'business' then 'Pending'
      else 'Retail'
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (
  id, email, full_name, phone, business_name, business_type, tier
)
select
  u.id,
  u.email,
  u.raw_user_meta_data->>'full_name',
  u.raw_user_meta_data->>'phone',
  u.raw_user_meta_data->>'business_name',
  u.raw_user_meta_data->>'business_type',
  case
    when u.raw_user_meta_data->>'account_type' = 'business' then 'Pending'
    else 'Retail'
  end
from auth.users as u
where not exists (
  select 1 from public.profiles as p where p.id = u.id
);

create table if not exists public.customer_notes (
  customer_id uuid primary key references public.profiles(id) on delete cascade,
  note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

alter table public.customer_notes enable row level security;
drop policy if exists "staff manage customer notes" on public.customer_notes;
create policy "staff manage customer notes"
  on public.customer_notes
  for all
  using (public.is_staff())
  with check (public.is_staff());

grant select, insert, update, delete on public.customer_notes to authenticated;

create or replace function public.update_chat_thread_after_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_threads
  set last_message = new.body,
      staff_unread = (new.kind = 'customer')
  where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists messages_update_chat_thread on public.messages;
create trigger messages_update_chat_thread
  after insert on public.messages
  for each row execute function public.update_chat_thread_after_message();

create or replace function public.submit_supply_request(
  p_business_name text,
  p_business_type text,
  p_contact_person text,
  p_phone text,
  p_zone_code text,
  p_needed_by date,
  p_items jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id text;
  v_item jsonb;
  v_product_id text;
  v_description text;
  v_pack text;
  v_qty integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in before submitting a supply request';
  end if;
  if nullif(trim(coalesce(p_business_name, '')), '') is null then
    raise exception 'Business name is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Add at least one request item';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one request item';
  end if;

  insert into public.supply_requests (
    user_id, business_name, business_type, contact_person, phone, zone_code, needed_by, status
  )
  values (
    auth.uid(), trim(p_business_name), nullif(trim(coalesce(p_business_type, '')), ''),
    nullif(trim(coalesce(p_contact_person, '')), ''), nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_zone_code, '')), ''), p_needed_by, 'New'
  )
  returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := nullif(v_item->>'product_id', '');
    v_description := nullif(trim(coalesce(v_item->>'custom_description', '')), '');
    v_pack := coalesce(v_item->>'pack', '');
    v_qty := coalesce(nullif(v_item->>'qty', '')::integer, 0);

    if v_pack not in ('Single', 'Dozen', 'Carton') or v_qty < 1 then
      raise exception 'Invalid supply request item';
    end if;
    if v_product_id is null then
      if v_description is null then
        raise exception 'Describe each custom item';
      end if;
    elsif not exists (
      select 1 from public.products where id = v_product_id and status = 'active'
    ) then
      raise exception 'Requested product is unavailable: %', v_product_id;
    end if;

    insert into public.supply_request_items (
      request_id, product_id, custom_description, pack, qty
    )
    values (v_request_id, v_product_id, v_description, v_pack, v_qty);
  end loop;

  return v_request_id;
end;
$$;

grant execute on function public.submit_supply_request(text, text, text, text, text, date, jsonb) to authenticated;

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
  v_zone public.delivery_zones%rowtype;
  v_item jsonb;
  v_prod public.products%rowtype;
  v_price numeric;
  v_qty integer;
  v_mode text;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null
    or nullif(trim(coalesce(p_phone, '')), '') is null then
    raise exception 'BAD_DETAILS';
  end if;
  if p_method is null or p_method not in ('online', 'cash', 'transfer') then
    raise exception 'BAD_DETAILS';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'EMPTY_CART';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
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
    if v_qty < 1 then
      raise exception 'BAD_QTY';
    end if;
    v_mode := coalesce(v_item->>'mode', 'single');
    if v_mode not in ('single', 'wholesale') then
      raise exception 'BAD_ITEM';
    end if;
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
    if not found then
      raise exception 'UNAVAILABLE';
    end if;
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
  update public.orders
  set subtotal = v_sub, delivery_fee = v_fee, total = v_sub + v_fee
  where id = v_id;

  return v_id;
end;
$$;

grant execute on function public.place_order(text, text, text, text, text, text, text, jsonb) to authenticated;
