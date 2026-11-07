begin;

alter table public.orders
  add column if not exists payment_proof_path text,
  add column if not exists payment_reviewed_at timestamptz,
  add column if not exists payment_reviewed_by uuid references public.profiles(id),
  add column if not exists payment_rejection_reason text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs',
  'payment-proofs',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "customers upload own payment proofs" on storage.objects;
create policy "customers upload own payment proofs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.orders o
      where o.id = (storage.foldername(name))[2]
        and o.user_id = auth.uid()
        and o.payment_method = 'online'
    )
  );

drop policy if exists "customers and staff read payment proofs" on storage.objects;
create policy "customers and staff read payment proofs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      public.is_staff()
      or (
        (storage.foldername(name))[1] = auth.uid()::text
        and exists (
          select 1 from public.orders o
          where o.id = (storage.foldername(name))[2]
            and o.user_id = auth.uid()
        )
      )
    )
  );

create or replace function public.submit_order_payment(
  p_order_id text,
  p_file_path text default null
) returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before submitting payment';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found or v_order.user_id <> auth.uid() then
    raise exception 'Order not found';
  end if;
  if v_order.payment_method <> 'online' then
    raise exception 'Payment proof is only available for online orders';
  end if;
  if v_order.payment_status = 'paid' then
    raise exception 'This order is already paid';
  end if;
  if p_file_path is not null then
    if left(p_file_path, length(auth.uid()::text || '/' || p_order_id || '/'))
      <> auth.uid()::text || '/' || p_order_id || '/' then
      raise exception 'Invalid payment proof path';
    end if;
    if not exists (
      select 1 from storage.objects
      where bucket_id = 'payment-proofs' and name = p_file_path
    ) then
      raise exception 'Payment proof upload was not found';
    end if;
  end if;

  update public.orders
  set payment_status = 'awaiting_confirmation',
      payment_proof_path = p_file_path,
      payment_reviewed_at = null,
      payment_reviewed_by = null,
      payment_rejection_reason = null
  where id = p_order_id;
end;
$$;

create or replace function public.review_order_payment(
  p_order_id text,
  p_decision text,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_status text;
  v_title text;
begin
  if not public.is_staff() then
    raise exception 'Staff access required';
  end if;
  if p_decision is null or p_decision not in ('paid', 'rejected') then
    raise exception 'Invalid payment decision';
  end if;
  if p_decision = 'rejected' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Provide a reason for rejecting this payment';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;
  if v_order.payment_status is distinct from 'awaiting_confirmation' then
    raise exception 'This payment is not awaiting confirmation';
  end if;

  v_status := p_decision;
  update public.orders
  set payment_status = v_status,
      payment_reviewed_at = now(),
      payment_reviewed_by = auth.uid(),
      payment_rejection_reason = case when v_status = 'rejected' then nullif(trim(coalesce(p_reason, '')), '') else null end
  where id = p_order_id;

  v_title := case
    when v_status = 'paid' then 'Payment confirmed for order ' || p_order_id
    else 'Payment rejected for order ' || p_order_id
      || case when nullif(trim(coalesce(p_reason, '')), '') is null then '' else ': ' || trim(p_reason) end
  end;
  insert into public.notifications (user_id, category, title, href)
  values (v_order.user_id, 'orders', v_title, 'order-details.html?id=' || p_order_id);
end;
$$;

revoke all on function public.submit_order_payment(text, text) from public;
revoke all on function public.review_order_payment(text, text, text) from public;
grant execute on function public.submit_order_payment(text, text) to authenticated;
grant execute on function public.review_order_payment(text, text, text) to authenticated;

commit;
