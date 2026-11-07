(function () {
  const config = window.BC_CONFIG || {};
  const accounts = Array.isArray(config.BANK_ACCOUNTS) ? config.BANK_ACCOUNTS : [];
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const money = value => '₦' + Number(value || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });

  function showToast(message) {
    document.querySelectorAll('.toast.payment-toast').forEach(toast => toast.remove());
    const toast = document.createElement('div');
    toast.className = 'toast payment-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function renderAccounts(amount, orderId) {
    return `<section class="bank-payment">
      <h3>Pay by bank transfer</h3>
      <p>Amount to pay: <strong>${money(amount)}</strong></p>
      ${orderId
        ? `<p>Use <strong>${esc(orderId)}</strong> as your transfer reference.</p>`
        : '<p>Your order number will be shown as the transfer reference after you place your order.</p>'}
      <div class="bank-account-list">${accounts.map(account => `
        <article class="bank-account">
          <strong>${esc(account.bank)}</strong>
          <span class="bank-account-number">${esc(account.account_number)}</span>
          <span>Account name: ${esc(account.account_name)}</span>
          <button type="button" class="btn outline" data-copy-account="${esc(account.account_number)}">Copy</button>
        </article>`).join('')}</div>
      <p class="muted">Your order is confirmed after we verify your payment.</p>
    </section>`;
  }

  function renderOrderPayment(order) {
    if (!order || order.payment_method !== 'online' || String(order.payment_status || 'pending').toLowerCase() === 'paid') return '';
    const status = String(order.payment_status || 'pending').toLowerCase();
    const submitted = status === 'awaiting_confirmation';
    return `<section class="card payment-instructions" data-payment-order="${esc(order.id)}">
      ${renderAccounts(order.total, order.id)}
      ${status === 'rejected' ? `<p class="payment-error">Your previous payment submission was rejected.${order.payment_rejection_reason ? ` Reason: ${esc(order.payment_rejection_reason)}` : ''} Please review the details and submit again.</p>` : ''}
      ${submitted
        ? `<p role="status">Payment submitted${order.payment_proof_path ? ' with proof' : ''}. We are verifying it now.</p>`
        : `<label class="proof-label" for="paymentProof">Proof of payment (optional; image or PDF, up to 10 MB)</label>
          <input id="paymentProof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">
          <button class="btn" type="button" data-submit-payment>I have paid</button>
          <p class="payment-error" data-payment-error role="alert"></p>`}
    </section>`;
  }

  function bind(root, sb, user, orderOrResolver) {
    if (!root || root.dataset.paymentUiBound) return;
    root.dataset.paymentUiBound = 'true';
    root.addEventListener('click', async event => {
      const copyButton = event.target.closest('[data-copy-account]');
      if (copyButton) {
        try {
          await navigator.clipboard.writeText(copyButton.dataset.copyAccount);
          showToast('Copied');
        } catch (error) {
          console.error('Could not copy account number:', error);
          showToast('Copy failed. Please copy the account number manually.');
        }
        return;
      }

      const submitButton = event.target.closest('[data-submit-payment]');
      if (!submitButton) return;
      const section = submitButton.closest('.payment-instructions');
      const order = typeof orderOrResolver === 'function'
        ? orderOrResolver(section && section.dataset.paymentOrder)
        : orderOrResolver;
      const errorNode = section && section.querySelector('[data-payment-error]');
      const fileInput = section && section.querySelector('#paymentProof');
      const file = fileInput && fileInput.files && fileInput.files[0];
      let filePath = null;
      submitButton.disabled = true;
      submitButton.textContent = 'Submitting…';
      if (errorNode) errorNode.textContent = '';

      try {
        if (!sb || !user || !order || order.payment_method !== 'online') {
          throw new Error('Your order session is unavailable. Reload the page and try again.');
        }
        if (file) {
          const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
          if (!allowedTypes.includes(file.type)) throw new Error('Choose a JPG, PNG, WebP image, or PDF file.');
          if (file.size > 10 * 1024 * 1024) throw new Error('The proof file must be 10 MB or smaller.');
          const extension = file.type === 'application/pdf' ? 'pdf'
            : file.type === 'image/png' ? 'png'
              : file.type === 'image/webp' ? 'webp' : 'jpg';
          const fileId = window.crypto && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          filePath = `${user.id}/${order.id}/${fileId}.${extension}`;
          const { error: uploadError } = await sb.storage.from('payment-proofs').upload(filePath, file, {
            contentType: file.type,
            upsert: false
          });
          if (uploadError) throw uploadError;
        }
        const { error } = await sb.rpc('submit_order_payment', {
          p_order_id: order.id,
          p_file_path: filePath
        });
        if (error) {
          if (filePath) {
            const { error: removeError } = await sb.storage.from('payment-proofs').remove([filePath]);
            if (removeError) console.error('Could not remove unused payment proof:', removeError);
          }
          throw error;
        }
        order.payment_status = 'awaiting_confirmation';
        order.payment_proof_path = filePath;
        section.outerHTML = renderOrderPayment(order);
        showToast('Payment submitted for confirmation.');
      } catch (error) {
        console.error('Could not submit payment confirmation:', error);
        if (errorNode) errorNode.textContent = error.message || 'Could not submit payment. Please try again.';
        submitButton.disabled = false;
        submitButton.textContent = 'I have paid';
      }
    });
  }

  window.BCPayment = { renderAccounts, renderOrderPayment, bind };
})();
