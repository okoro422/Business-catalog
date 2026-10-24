/* Business Catalog - LIVE backend (Supabase).  version 2.2
   Handles client loading gracefully, disabling interactive forms until ready. */
(function () {
  const C = window.BC_CONFIG || {};
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.BC) return;   // demo mode: stay out of the way

  const BC = window.BC, A = window.ADMIN;
  const body = document.body, isAdmin = (body.dataset.layout || 'shop') === 'admin';
  const PAGE = ((location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '')) || 'index';
  const NEEDS_LOGIN = ['account', 'my-orders', 'my-quotes', 'supply-request', 'wishlist', 'cancel-return', 'chat', 'notifications'];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const never = () => new Promise(() => {});
  const domReady = new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r());
  const must = r => { if (r.error) throw new Error(r.error.message); return r.data; };
  
  const live = window.BCLive = { user: null, profile: null, sb: null, ready: false };
  live.isStaff = () => !!live.profile && (live.profile.role === 'staff' || live.profile.role === 'owner');

  /* ---------- Lock UI elements while loading ---------- */
  domReady.then(() => {
    document.querySelectorAll('form button[type="submit"]').forEach(btn => {
      if (!btn.disabled) {
        btn.disabled = true;
        btn.dataset.origText = btn.textContent;
        btn.textContent = 'Connecting database...';
      }
    });
  });

  /* ---------- load the Supabase library instantly ---------- */
  if (!window.supabase) {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    document.head.appendChild(s);
  }

  let sb;
  const sdk = new Promise((res, rej) => {
    const check = () => {
      if (window.supabase && window.supabase.createClient) {
        try {
          sb = live.sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
          live.ready = true;
          domReady.then(() => {
            document.querySelectorAll('form button[type="submit"]').forEach(btn => {
              btn.disabled = false;
              if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
            });
          });
          return res();
        } catch (e) {
          return rej(e);
        }
      }
      setTimeout(check, 50);
    };
    check();
  });

  /* ---------- small helpers ---------- */
  const ago = ts => {
    if (!ts) return '—'; const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 90) return 'Just now'; if (s < 3600) return Math.round(s / 60) + ' minutes ago'; if (s < 86400) return Math.round(s / 3600) + ' hours ago';
    const d = Math.round(s / 86400); return d === 1 ? 'Yesterday' : d + ' days ago';
  };
  const seen = ts => { if (!ts) return '—'; const d = Math.floor((Date.now() - new Date(ts).getTime()) / 864e5); return d < 1 ? 'Today' : d + 'd ago'; };
  const clock = ts => { const d = new Date(ts), t = d.toTimeString().slice(0, 5); return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + t; };
  const trend = n => n == null ? '' : (n >= 0 ? '▲ ' : '▼ ') + Math.abs(n) + '%';
  const fail = r => { if (r && r.error) { (A && isAdmin ? A.toast : BC.toast)('Could not save: ' + r.error.message); } return r; };
  const poll = (fn, cb, ms, table) => {                  
    let stopped = false, ch = null;
    const tick = async () => { if (stopped || document.hidden) return; try { cb(await fn()); } catch (e) {} };
    const id = setInterval(tick, ms);
    try { ch = sb.channel('bc-' + table + '-' + Math.random().toString(36).slice(2, 7)).on('postgres_changes', { event: '*', schema: 'public', table }, tick).subscribe(); } catch (e) {}
    return () => { stopped = true; clearInterval(id); try { if (ch) sb.removeChannel(ch); } catch (e) {} };
  };

  /* ---------- sign in / up / out ---------- */
  live.signIn = async (email, password) => {
    await sdk;
    if (!/@/.test(String(email))) throw new Error('Please sign in with your email address.');
    const { error } = await sb.auth.signInWithPassword({ email: String(email).trim(), password });
    if (error) throw new Error(error.message);
  };
  live.signUp = async f => {
    await sdk;
    const { data, error } = await sb.auth.signUp({ email: f.email.trim(), password: f.password,
      options: { data: { full_name: f.name, phone: f.phone, account_type: f.type, business_name: f.bname || null, business_type: f.btype || null } } });
    if (error) throw new Error(error.message);
    return { needsConfirm: !data.session };
  };
  live.signOut = async () => { await sdk; await sb.auth.signOut(); };
  live.staffSignIn = async (email, password) => {
    await live.signIn(email, password);
    const { data: u } = await sb.auth.getUser();
    const r = await sb.from('profiles').select('role').eq('id', u.user.id).maybeSingle();
    if (!r.data || !['staff', 'owner'].includes(r.data.role)) { await sb.auth.signOut(); throw new Error('This account does not have staff access.'); }
  };

  /* ---------- mapping database rows to the shapes the pages use ---------- */
  const defTiers = p => [{ label: 'Dozen', qty: 12, price: Math.round(p * .83 / 10) * 10 }, { label: '48 pcs', qty: 48, price: Math.round(p * .75 / 10) * 10 }, { label: 'Carton', qty: 96, price: Math.round(p * .68 / 10) * 10 }];
  const mapProduct = r => {
    let t = (r.product_tiers || []).slice().sort((a, b) => a.min_qty - b.min_qty).map(x => ({ label: x.label, qty: x.min_qty, price: +x.price }));
    if (!t.length) t = defTiers(+r.price);
    while (t.length < 3) t.push(t[t.length - 1]);
    return { id: r.id, name: r.name, cat: r.category_slug, price: +r.price, stock: r.stock, icon: r.icon || 'fa-pump-soap', bulk: !!r.is_bulk, img: r.image_url || '',
      status: r.status, sku: r.sku, brand: r.brand, cost: r.cost == null ? null : +r.cost, reorder: r.reorder_level, featured: !!r.featured,
      desc: r.description || '', ingr: r.ingredients || '', how: r.how_to_use || '', tiers: t };
  };
  const zoneName = c => (BC.zones[c] && BC.zones[c].name) || ('Zone ' + c);
  const mapOrder = o => ({ id: o.id, date: o.created_at, status: o.status, customer: o.customer_name, phone: o.phone, method: o.payment_method, zone: zoneName(o.zone_code),
    area: o.area, street: o.street, subtotal: +o.subtotal, fee: +o.delivery_fee, total: +o.total,
    items: (o.order_items || []).map(i => ({ name: i.name, qty: i.qty, price: +i.unit_price, total: +i.line_total })) });

  /* ======================= CUSTOMER SIDE ======================= */
  let myOrders = [], myQuotes = [], wl = [], addrs = [], thread = null, unreadNotes = 0;

  BC.order.all = () => myOrders;
  BC.order.place = async () => {
    await sdk;
    const lines = BC.cart.lines(); if (!lines.length) throw new Error('Your cart is empty.');
    const info = BC.info.get(), z = info.zone || 'A';
    const data = must(await sb.rpc('place_order', { p_name: info.name, p_phone: info.phone, p_zone: z, p_area: info.area, p_street: info.street, p_landmark: info.landmark || null,
      p_method: BC.pay.get(), p_items: lines.map(l => ({ product_id: l.id, qty: l.qty, mode: l.mode })) }));
    const r = typeof data === 'string' ? JSON.parse(data) : data;     
    const o = { id: r.id, date: new Date().toISOString(), status: 'Placed', items: lines.map(l => ({ name: l.name, qty: l.qty, price: l.price, total: l.total })),
      subtotal: +r.subtotal, fee: +r.delivery_fee, total: +r.total, zone: zoneName(z), area: info.area, street: info.street, customer: info.name, phone: info.phone, method: BC.pay.get() };
    try { localStorage.setItem('bc_last_order', JSON.stringify(o)); } catch (e) {}
    BC.cart.clear();
    if (live.user) myOrders.unshift(o);
    return o;
  };

  BC.wish.get = () => wl;
  BC.wish.has = id => wl.includes(id);
  BC.wish.toggle = id => {
    if (!live.user) { BC.toast('Please sign in to save items'); return false; }
    const i = wl.indexOf(id);
    if (i < 0) { wl.push(id); sb.from('wishlist').upsert({ user_id: live.user.id, product_id: id }).then(fail); return true; }
    wl.splice(i, 1); sb.from('wishlist').delete().eq('user_id', live.user.id).eq('product_id', id).then(fail); return false;
  };
  BC.wish.remove = id => { const i = wl.indexOf(id); if (i >= 0) wl.splice(i, 1); if (live.user) sb.from('wishlist').delete().eq('user_id', live.user.id).eq('product_id', id).then(fail); };

  BC.profile = {
    get() { const p = live.profile || {}; return { name: p.full_name || '', phone: p.phone || '', email: (live.user && live.user.email) || '' }; },
    async save(p) { must(await sb.from('profiles').update({ full_name: p.name, phone: p.phone }).eq('id', live.user.id)); live.profile = Object.assign({}, live.profile, { full_name: p.name, phone: p.phone }); },
    async changePassword(cur, nw) {
      const a = await sb.auth.signInWithPassword({ email: live.user.email, password: cur });
      if (a.error) throw new Error('Your current password is not correct.');
      const r = await sb.auth.updateUser({ password: nw }); if (r.error) throw new Error(r.error.message);
    }
  };
  const mapAddr = a => ({ id: a.id, label: a.label, note: a.note || '', def: !!a.is_default });
  BC.addresses = {
    get: () => addrs,
    async add(label, note) { const r = await sb.from('addresses').insert({ user_id: live.user.id, label, note, is_default: addrs.length === 0 }).select().single(); addrs.push(mapAddr(must(r))); },
    async setDefault(id) { addrs.forEach(a => { a.def = a.id === id; }); await sb.from('addresses').update({ is_default: false }).eq('id', live.user.id); fail(await sb.from('addresses').update({ is_default: true }).eq('id', id)); },
    async remove(id) { addrs = addrs.filter(a => a.id !== id); fail(await sb.from('addresses').delete().eq('id', id)); }
  };
  BC.requestChange = async req => { must(await sb.from('order_requests').insert({ order_id: req.id, user_id: live.user.id, type: req.type, reason: req.reason, notes: req.notes })); };

  /* wholesale quotes (customer) */
  const Q_STATUS = { New: 'In review', 'In review': 'In review', Quoted: 'Quote ready', Accepted: 'Accepted', Declined: 'Declined' };
  const daysLeft = d => d ? Math.max(0, Math.ceil((new Date(d + 'T23:59:59').getTime() - Date.now()) / 864e5)) : 7;
  const mapQuote = r => ({ id: r.id, title: r.business_name, items: (r.supply_request_items || []).length, status: Q_STATUS[r.status] || r.status,
    total: r.total == null ? undefined : +r.total, validDays: daysLeft(r.valid_until), order: r.order_id || undefined, created: r.created_at });
  BC.quotes.all = () => myQuotes;
  BC.quotes.add = async data => {
    const rq = data.request || {}, zm = /Zone ([A-Z])/.exec(rq.zone || '');
    const r = must(await sb.from('supply_requests').insert({ user_id: live.user.id, business_name: data.title, business_type: rq.type || null, contact_person: rq.contact || null, phone: rq.phone || null,
      zone_code: zm ? zm[1] : null, needed_by: rq.needed || null, status: 'New' }).select().single());
    const rows = (rq.rows || []).map(x => ({ request_id: r.id, product_id: x.product === 'custom' ? null : x.product, custom_description: x.product === 'custom' ? x.custom : null, pack: x.pack, qty: x.qty }));
    const it = await sb.from('supply_request_items').insert(rows);
    if (it.error) { await sb.from('supply_requests').delete().eq('id', r.id); throw new Error(it.error.message); }
    const q = mapQuote(Object.assign({}, r, { supply_request_items: rows })); myQuotes.unshift(q); return q;
  };
  BC.quotes.setStatus = (id, status) => {
    const q = myQuotes.find(x => x.id === id); if (!q) return; const prev = q.status; q.status = status;
    sb.from('supply_requests').update({ status }).eq('id', id).then(r => { if (r.error) { q.status = prev; BC.toast('Could not save: ' + r.error.message); } });
  };

  /* chat (customer) */
  BC.chat = {
    async load() {
      await sdk;
      if (!thread) thread = (await sb.from('chat_threads').select('*').eq('customer_id', live.user.id).maybeSingle()).data || null;
      if (!thread) return [];
      const m = must(await sb.from('messages').select('*').eq('thread_id', thread.id).order('created_at'));
      return m.filter(x => x.kind !== 'internal').map(x => ({ t: x.kind === 'customer' ? 'out' : x.kind === 'staff' ? 'in' : 'note', x: x.body }));
    },
    async send(text) {
      if (!thread) thread = must(await sb.from('chat_threads').insert({ customer_id: live.user.id, subject: 'Support chat' }).select().single());
      must(await sb.from('messages').insert({ thread_id: thread.id, sender_id: live.user.id, kind: 'customer', body: text }));
    },
    watch: cb => poll(() => BC.chat.load(), cb, 6000, 'messages')
  };

  /* notifications */
  BC.notifications = {
    async list() {
      const r = must(await sb.from('notifications').select('*').eq('user_id', live.user.id).order('created_at', { ascending: false }).limit(100));
      return r.map(n => ({ id: n.id, c: n.category || 'messages', t: n.title, w: ago(n.created_at), href: n.href || 'notifications.html', read: !!n.is_read }));
    },
    async markRead(id) { fail(await sb.from('notifications').update({ is_read: true }).eq('id', id)); },
    async markAll() { fail(await sb.from('notifications').update({ is_read: true }).eq('user_id', live.user.id).eq('is_read', false)); }
  };

  /* ======================= STAFF SIDE ======================= */
  live.saveProduct = async (p, file) => {
    await sdk;
    const row = { id: p.id, name: p.name, sku: p.sku, brand: p.brand, category_slug: p.cat, price: p.price, cost: p.cost, stock: p.stock, reorder_level: p.reorder, is_bulk: p.bulk,
      featured: p.featured, status: p.status, description: p.desc || null, ingredients: p.ingr || null, how_to_use: p.how || null };
    if (file) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = p.id + '-' + Date.now() + '.' + ext;
      const up = await sb.storage.from('product-images').upload(path, file, { upsert: true, contentType: file.type });
      if (up.error) throw new Error('Image upload failed: ' + up.error.message);
      row.image_url = sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
    }
    must(await sb.from('products').upsert(row));
    must(await sb.from('product_tiers').delete().eq('product_id', p.id));
    must(await sb.from('product_tiers').insert(p.tiers.map(t => ({ product_id: p.id, label: t.label, min_qty: t.qty, price: t.price }))));
  };

  if (A) {
    const PAY = { online: 'Online', cash: 'Cash on delivery', transfer: 'Transfer on delivery' };
    const money = n => n >= 1e6 ? '₦' + (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? '₦' + Math.round(n / 1000) + 'k' : '₦' + Math.round(n);
    const MULT = { Single: 1, Dozen: 12, Carton: 96 };
    A.money = money; A.status = o => o.status;
    A.me = () => ({ name: (live.profile && (live.profile.full_name || live.profile.email)) || 'there' });
    A.setStatus = (id, s) => {
      const o = A.orders.find(x => x.id === id); if (!o) return;
      const prev = o.status; o.status = s;
      sb.from('orders').update({ status: s === 'New' ? 'Placed' : s }).eq('id', id).then(r => { if (r.error) { o.status = prev; A.toast('Could not update: ' + r.error.message); } else A.log('Status change', id + ' ' + s); });
    };
    A.isPaid = o => !!o.paid;
    A.markPaid = id => { const o = A.orders.find(x => x.id === id); if (!o) return; o.paid = true; sb.from('orders').update({ payment_status: 'paid' }).eq('id', id).then(r => { if (r.error) { o.paid = false; A.toast('Could not save: ' + r.error.message); } else A.log('Payment received', id); }); };
    const saveStaffData = o => sb.from('order_staff_data').upsert({ order_id: o.id, internal_note: o.note || '', rider: o.rider || '' }).then(fail);
    A.getNote = o => o.note || ''; A.getRider = o => o.rider || '';
    A.saveNote = (id, t) => { const o = A.orders.find(x => x.id === id); if (o) { o.note = t; saveStaffData(o); } };
    A.saveRider = (id, r) => { const o = A.orders.find(x => x.id === id); if (o) { o.rider = r; saveStaffData(o); } };
    A.requestsFor = async id => must(await sb.from('order_requests').select('*').eq('order_id', id).order('created_at', { ascending: false })).map(r => ({ id: r.id, type: r.type, reason: r.reason, notes: r.notes, at: r.created_at, status: r.status }));
    A.closeRequest = async id => { must(await sb.from('order_requests').update({ status: 'closed' }).eq('id', id)); };
    A.tierOf = c => c.tier;
    A.approve = id => { const c = A.customers.find(x => x.id === id); if (!c) return; c.tier = 'Wholesale T1'; sb.from('profiles').update({ tier: 'Wholesale T1', role: 'wholesale' }).eq('id', id).then(fail); };
    A.getCustomerNote = c => c.note || '';
    A.saveCustomerNote = (id, t) => { const c = A.customers.find(x => x.id === id); if (c) c.note = t; sb.from('customer_notes').upsert({ customer_id: id, note: t }).then(fail); };
    A.ordersOf = c => A.orders.filter(o => o.user_id === c.id);
    A.log = (action, item) => { if (live.user) sb.from('activity_log').insert({ staff_id: live.user.id, action, item: String(item || '') }).then(() => {}); };
    A.setSupplyStatus = (id, s) => { const r = A.supply.find(x => x.id === id); if (!r) return; const prev = r.status; r.status = s; sb.from('supply_requests').update({ status: s }).eq('id', id).then(x => { if (x.error) { r.status = prev; A.toast('Could not save: ' + x.error.message); } else A.log('Quote ' + s.toLowerCase(), id); }); };
    A.supplyStatus = r => r.status;

    A.getQuote = async id => {
      const r = must(await sb.from('supply_requests').select('*, supply_request_items(*)').eq('id', id).maybeSingle()); if (!r) return null;
      const lines = (r.supply_request_items || []).map(i => {
        const p = i.product_id ? BC.byIdAny(i.product_id) : null, units = i.qty * (MULT[i.pack] || 1);
        const suggested = p ? BC.priceFor(p, units, units >= 12 ? 'wholesale' : 'single') : 0;
        return { id: i.id, n: p ? p.name : (i.custom_description || 'Custom item'), pack: i.pack + ' × ' + i.qty, units, price: i.unit_price != null ? +i.unit_price : suggested, custom: !p, stocked: !!p && p.stock >= units };
      });
      return { request: { id: r.id, biz: r.business_name, zone: r.zone_code || '-', status: r.status, contact: r.contact_person || '', phone: r.phone || '', needed: r.needed_by || '' }, lines };
    };
    A.sendQuote = async (id, d) => {
      for (const l of d.lines) must(await sb.from('supply_request_items').update({ unit_price: l.price || null }).eq('id', l.id));
      must(await sb.from('supply_requests').update({ status: 'Quoted', discount: d.discount || 0, delivery_fee: d.delivery || 0, total: d.total, valid_until: d.valid }).eq('id', id));
      const r = A.supply.find(x => x.id === id); if (r) r.status = 'Quoted'; A.log('Quote quoted', id);
    };

    A.dashboard = async period => {
      const d = must(await sb.rpc('admin_dashboard', { p_period: period }));
      return { revenue: money(+d.revenue), revenueTrend: trend(d.revenue_trend), orders: String(d.orders), ordersTrend: trend(d.orders_trend), pendingQuotes: d.pending_quotes, unreadChats: d.unread_chats,
        series: (d.series || []).map(x => ({ label: x.label, value: +x.revenue })),
        needs: [[d.new_orders + ' new orders', 'admin-orders.html'], [d.pending_quotes + ' quotes awaiting', 'admin-supply-requests.html'], [d.low_stock + ' low-stock items', 'admin-products.html'], [d.transfers_to_verify + ' payments to verify', 'admin-orders.html']] };
    };
    A.reports = async days => {
      const d = must(await sb.rpc('admin_reports', { p_days: days || 30 }));
      const hrs = +d.avg_hours, avg = hrs ? (hrs >= 24 ? Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h' : hrs + 'h') : '—';
      const zones = d.by_zone || [], total = zones.reduce((s, z) => s + z.orders, 0), za = zones.find(z => z.zone === 'A');
      return {
        Sales: { m: [['Revenue', money(+d.revenue)], ['Orders', String(d.orders)], ['Average order', money(+d.avg_order)], ['Wholesale share', d.wholesale_share + '%']], head: ['Day', 'Revenue (₦k)', 'Orders'], rows: (d.daily || []).map(x => [x.day, Math.round(x.revenue / 1000), x.orders]), chart: 1 },
        Products: { m: [['Products', String(d.skus)], ['Top seller', d.top_products && d.top_products[0] ? d.top_products[0].name : '—'], ['Low stock', String(d.low_stock)], ['Out of stock', String(d.out_of_stock)]], head: ['Product', 'Units sold', 'Revenue'], rows: (d.top_products || []).map(x => [x.name, x.units, money(+x.revenue)]) },
        Customers: { m: [['New customers', String(d.new_customers)], ['Repeat rate', d.repeat_rate + '%'], ['Wholesale accounts', String(d.wholesale_accounts)], ['Pending approval', String(d.pending_approval)]], head: ['Customer', 'Orders', 'Spent'], rows: (d.top_customers || []).map(x => [x.name, x.orders, money(+x.spent)]) },
        Delivery: { m: [['Deliveries', String(d.deliveries)], ['Average time', avg], ['Zone A share', total ? Math.round(100 * (za ? za.orders : 0) / total) + '%' : '—'], ['Cancelled', String(d.cancelled)]], head: ['Zone', 'Orders', 'Revenue'], rows: zones.map(z => ['Zone ' + z.zone, z.orders, money(+z.revenue)]) },
        Stock: { m: [['SKUs', String(d.skus)], ['Low stock', String(d.low_stock)], ['Out of stock', String(d.out_of_stock)], ['Stock value', money(+d.stock_value)]], head: ['Item', 'On hand', 'Reorder level'], rows: (d.low_list || []).map(x => [x.name, x.stock, x.reorder]) }
      };
    };

    A.chat = {
      async threads() {
        const t = must(await sb.from('chat_threads').select('*').order('updated_at', { ascending: false }));
        return t.map(x => { const p = A._profiles && A._profiles[x.customer_id]; return { id: x.id, name: p ? (p.business_name || p.full_name || p.email) : 'Customer', preview: x.last_message || '', unread: !!x.staff_unread }; });
      },
      async messages(id) { return must(await sb.from('messages').select('*').eq('thread_id', id).order('created_at')).map(m => [m.kind === 'customer' ? 'in' : m.kind === 'staff' ? 'out' : m.kind === 'internal' ? 'int' : 'note', m.body]); },
      async send(id, kind, text) { must(await sb.from('messages').insert({ thread_id: id, sender_id: live.user.id, kind: kind === 'int' ? 'internal' : 'staff', body: text })); },
      async markRead(id) { fail(await sb.from('chat_threads').update({ staff_unread: false }).eq('id', id)); },
      async quickReplies() { const s = must(await sb.from('settings').select('*').eq('key', 'chat').maybeSingle()); return (s && s.value && s.value.quick_replies) || []; },
      watch: cb => poll(() => A.chat.threads(), cb, 6000, 'messages')
    };
    A.cats = {
      async list() {
        const c = must(await sb.from('categories').select('*').order('name')), prods = BC.allProducts || [];
        const count = slug => prods.filter(p => p.cat === slug || (c.find(x => x.slug === p.cat) || {}).parent_slug === slug).length;
        return c.map(x => ({ id: x.slug, name: x.name, n: count(x.slug), p: x.parent_slug || '', d: x.description || '' }));
      },
      async add(c) { must(await sb.from('categories').insert({ slug: c.id, name: c.name, parent_slug: c.p || null, description: c.d || null })); BC.categories.push({ slug: c.id, name: c.name, parent: c.p || '' }); },
      async remove(id) {
        const r = await sb.from('categories').delete().eq('slug', id);
        if (r.error) throw new Error(/foreign key|violates/i.test(r.error.message) ? 'This category still has products. Move or delete those products first.' : r.error.message);
        for (let i = BC.categories.length - 1; i >= 0; i--) if (BC.categories[i].slug === id || BC.categories[i].parent === id) BC.categories.splice(i, 1);
      }
    };
    A.zones = {
      async list() { return must(await sb.from('delivery_zones').select('*').order('code')).map(z => ({ code: z.code, name: z.name, areas: z.areas || [], fee: +z.fee, freeOver: z.free_over == null ? null : +z.free_over, active: !!z.active })); },
      async save(code, v) { must(await sb.from('delivery_zones').update({ fee: v.fee, free_over: v.freeOver == null ? null : v.freeOver, active: v.active }).eq('code', code)); }
    };
    A.settings = {
      async get(key) { const r = must(await sb.from('settings').select('*').eq('key', key).maybeSingle()); return r ? r.value : null; },
      async set(key, value) { must(await sb.from('settings').upsert({ key, value, is_public: key === 'payment' })); }
    };
    A.staff = {
      async list() {
        const [m, i] = await Promise.all([sb.from('profiles').select('*').in('role', ['staff', 'owner']), sb.from('staff_invites').select('*')]);
        return { members: must(m).map(p => ({ id: p.id, name: p.full_name || p.email, title: p.role === 'owner' ? 'Owner' : (p.staff_title || 'Staff'), role: p.role, seen: seen(p.last_seen_at) })), invites: (i.data || []).map(x => ({ email: x.email, title: x.title })) };
      },
      async invite(email, title) { return must(await sb.rpc('invite_staff', { p_email: email, p_title: title })); },
      async remove(id) { must(await sb.rpc('remove_staff', { p_id: id })); },
      async removeInvite(email) { must(await sb.rpc('remove_invite', { p_email: email })); }
    };
    A.activityList = async () => must(await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(200))
      .map(a => { const p = A._profiles && A._profiles[a.staff_id]; return [clock(a.created_at), p ? (p.full_name || p.email) : 'Staff', a.action, a.item || '']; });
  }

  /* ======================= LOADING DATA ======================= */
  async function loadCatalogue() {
    const all = must(await sb.from('products').select('*, product_tiers(label,min_qty,price)').order('created_at')).map(mapProduct);
    BC.allProducts = all;
    BC.products.length = 0; all.filter(p => p.status === 'active').forEach(p => BC.products.push(p));
    const zs = must(await sb.from('delivery_zones').select('*').eq('active', true).order('code'));
    Object.keys(BC.zones).forEach(k => delete BC.zones[k]);
    zs.forEach(z => { BC.zones[z.code] = { name: z.name, short: 'Zone ' + z.code, areas: z.areas || [], fee: +z.fee, freeOver: z.free_over == null ? undefined : +z.free_over }; });
    const cs = must(await sb.from('categories').select('*').order('name'));
    BC.categories.length = 0; cs.forEach(c => BC.categories.push({ slug: c.slug, name: c.name, parent: c.parent_slug || '' }));
    const ps = await sb.from('settings').select('*').eq('key', 'payment').maybeSingle();
    if (ps.data && ps.data.value) { Object.keys(BC.settings.payment).forEach(k => delete BC.settings.payment[k]); Object.assign(BC.settings.payment, ps.data.value); }
  }
  async function loadCustomerData() {
    const uid = live.user.id;
    const [o, w, a, q, n] = await Promise.all([
      sb.from('orders').select('*, order_items(*)').eq('user_id', uid).order('created_at', { ascending: false }),
      sb.from('wishlist').select('product_id').eq('user_id', uid),
      sb.from('addresses').select('*').eq('user_id', uid),
      sb.from('supply_requests').select('*, supply_request_items(id)').eq('user_id', uid).order('created_at', { ascending: false }),
      sb.from('notifications').select('id').eq('user_id', uid).eq('is_read', false).limit(99)]);
    myOrders = must(o).map(mapOrder); wl = (w.data || []).map(x => x.product_id); addrs = (a.data || []).map(mapAddr);
    myQuotes = must(q).map(mapQuote); unreadNotes = (n.data || []).length;
  }
  async function loadAdminData() {
    const [o, p, os, cn, sr] = await Promise.all([sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }), sb.from('profiles').select('*'),
      sb.from('order_staff_data').select('*'), sb.from('customer_notes').select('*'), sb.from('supply_requests').select('*, supply_request_items(id)').order('created_at', { ascending: false })]);
    const orders = must(o), profiles = must(p), supply = must(sr);
    const prof = {}; profiles.forEach(x => { prof[x.id] = x; }); A._profiles = prof;
    const sd = {}; (os.data || []).forEach(x => { sd[x.order_id] = x; });
    const notes = {}; (cn.data || []).forEach(x => { notes[x.customer_id] = x.note; });
    A.orders.length = 0;
    orders.forEach(r => { const pr = prof[r.user_id], s = sd[r.id] || {};
      A.orders.push({ id: r.id, user_id: r.user_id, customer: r.customer_name, tier: (pr && pr.tier) || 'Guest', zone: r.zone_code, area: r.area || '', total: +r.total, status: r.status === 'Placed' ? 'New' : r.status,
        pay: PAY_LABEL[r.payment_method] || r.payment_method, paid: r.payment_status === 'paid', fee: +r.delivery_fee, phone: r.phone, street: r.street, date: r.created_at, note: s.internal_note || '', rider: s.rider || '',
        items: (r.order_items || []).map(i => [i.qty + ' × ' + i.name, +i.line_total]) }); });
    const st = {}, lastZone = {};
    orders.forEach(r => { if (!r.user_id) return; const s = st[r.user_id] || (st[r.user_id] = { n: 0, sum: 0 }); if (r.status !== 'Cancelled') { s.n++; s.sum += +r.total; } if (!lastZone[r.user_id]) lastZone[r.user_id] = r.zone_code; });
    A.customers.length = 0;
    profiles.filter(x => x.role === 'customer' || x.role === 'wholesale').forEach(x => { const s = st[x.id] || { n: 0, sum: 0 };
      A.customers.push({ id: x.id, name: x.business_name || x.full_name || x.email, tier: x.tier, orders: s.n, spent: s.n ? A.money(s.sum) : '—', lifetime: A.money(s.sum), avg: s.n ? A.money(s.sum / s.n) : '—', out: '₦0',
        zone: lastZone[x.id] || '-', phone: x.phone || '', note: notes[x.id] || '' }); });
    A.supply.length = 0;
    supply.forEach(r => A.supply.push({ id: r.id, user_id: r.user_id, biz: r.business_name, zone: r.zone_code || '-', status: r.status, items: (r.supply_request_items || []).length }));
    sb.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', live.user.id).then(() => {});
  }
  const PAY_LABEL = { online: 'Online', cash: 'Cash on delivery', transfer: 'Transfer on delivery' };

  function decorate() {
    if (!live.user) document.querySelectorAll('a[href="account.html"]').forEach(a => a.setAttribute('href', 'signin.html'));
    else {
      document.querySelectorAll('.sheet a[href="signin.html"]').forEach(a => { a.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i>Sign out'; a.setAttribute('data-signout', ''); });
      if (unreadNotes) document.querySelectorAll('.header-actions a[href="notifications.html"]').forEach(a => a.insertAdjacentHTML('beforeend', '<span class="badge-dot">' + unreadNotes + '</span>'));
    }
  }
  function fatal(e) {
    const msg = (e && e.message) || String(e);
    document.documentElement.style.visibility = '';
    if (isAdmin) body.innerHTML = '<div style="padding:32px;font-family:sans-serif;max-width:560px"><h2>Could not connect to the database</h2><p style="margin:12px 0">' + esc(msg) + '</p><p>Check <b>config.js</b> (URL and anon key), that you ran the SQL setup, and your internet connection.</p></div>';
    else domReady.then(() => { const m = document.getElementById('main'); if (m) m.insertAdjacentHTML('afterbegin', '<div class="notice" style="background:#FBE7E3;border-color:#F0C4BC">Could not connect to the database: ' + esc(msg) + '</div>'); });
  }

  async function init() {
    if (isAdmin) document.documentElement.style.visibility = 'hidden';      
    await sdk;
    const s = await sb.auth.getSession();
    live.user = s.data && s.data.session ? s.data.session.user : null;
    if (live.user) { const r = await sb.from('profiles').select('*').eq('id', live.user.id).maybeSingle(); live.profile = r.data || null; }
    if (isAdmin && !live.user) { location.replace('staff-login.html'); return never(); }
    if (isAdmin && !live.isStaff()) { location.replace('staff-login.html?denied=1'); return never(); }
    if (NEEDS_LOGIN.includes(PAGE) && !live.user) { location.replace('signin.html?next=' + encodeURIComponent(PAGE + '.html' + location.search)); return never(); }
    await loadCatalogue();
    if (live.user) await loadCustomerData();
    if (isAdmin) await loadAdminData();
    await domReady; decorate();
    if (isAdmin) document.documentElement.style.visibility = '';
  }
  window.__bcLive = init().catch(fatal);
})();