// Agent desk: sign in, create a one-time consent link, watch it until the client
// signs, then show the captured signature and let the agent download the
// archived PDF. The session cookie is HttpOnly; this file only ever holds the
// in-memory CSRF token the server returns.
(function () {
  'use strict';

  const C = window.ConsentCore;
  const $ = (id) => document.getElementById(id);

  let agent = null;
  let csrf = '';
  let consents = [];
  let activeId = null;
  const links = new Map();      // consent id -> consent link (this session only)
  let pollTimer = null;
  let toastTimer = null;
  let sigObjectUrl = null;
  let sigForId = null;
  let sigLoadingForId = null;
  let sigRequestId = 0;

  // ── Small utilities ─────────────────────────────────────────────────────
  function toast(text, kind) {
    const el = $('toast');
    clearTimeout(toastTimer);
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; }, 4600);
  }

  function setError(id, message) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function activeRecord() {
    return consents.find((r) => r.id === activeId) || null;
  }

  function statusPill(el, status) {
    el.className = 'pill ' + C.statusClass(status);
    el.textContent = C.statusLabel(status);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'Working…';
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  async function api(path, options) {
    const opts = options || {};
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    if (method !== 'GET' && method !== 'HEAD' && csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
    if (res.status === 401 && !opts.allow401) {
      showLogin('Your session ended. Please sign in again.');
      throw new Error('Your session ended. Please sign in again.');
    }
    const type = res.headers.get('content-type') || '';
    const data = type.indexOf('application/json') !== -1 ? await res.json() : await res.text();
    if (!res.ok) {
      const message = (data && data.error) ? data.error : ('Request failed (' + res.status + ').');
      throw new Error(message);
    }
    return data;
  }

  async function fetchBlob(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 401) {
      showLogin('Your session ended. Please sign in again.');
      throw new Error('Your session ended. Please sign in again.');
    }
    if (!res.ok) {
      let message = 'Download failed (' + res.status + ').';
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch (e) { /* not JSON */ }
      throw new Error(message);
    }
    return res.blob();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // ── Views ───────────────────────────────────────────────────────────────
  function clearDesk() {
    $('consentForm').reset();
    $('searchRecords').value = '';
    $('filterRecords').value = 'all';
    $('recordsBody').textContent = '';
    $('recordsCount').textContent = '0 consent requests';
    $('recordsEmpty').hidden = false;
    $('linkPanel').hidden = true;
    $('consentLink').value = '';
    $('requestStatus').textContent = '';
    $('sessionNote').textContent = '';
    $('btnExportAll').disabled = true;
    setError('requestError', '');
    renderPreview();
  }

  function showLogin(message) {
    stopPolling();
    agent = null;
    csrf = '';
    consents = [];
    activeId = null;
    links.clear();
    clearDesk();
    document.body.classList.remove('booting');
    $('bootView').hidden = true;
    $('appView').hidden = true;
    $('loginView').hidden = false;
    $('loginPassword').value = '';
    setError('loginError', message || '');
    setTimeout(() => { try { $('loginPassword').focus(); } catch (e) {} }, 0);
  }

  function showApp() {
    document.body.classList.remove('booting');
    $('bootView').hidden = true;
    $('loginView').hidden = true;
    $('appView').hidden = false;
    $('agentRole').textContent = 'Team';
    startPolling();
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) { showLogin(''); return; }
      const data = await res.json();
      agent = data.agent;
      csrf = data.csrfToken;
      $('sessionNote').textContent = 'Session valid for up to ' + (data.sessionHours || 12) + ' hours';
      showApp();
      await loadConsents({ initial: true });
    } catch (e) {
      showLogin('Could not reach the consent service. Check the connection and try again.');
    }
  }

  async function login(event) {
    event.preventDefault();
    const password = $('loginPassword').value;
    if (!password) { setError('loginError', 'Enter the team password.'); return; }
    const btn = $('loginBtn');
    setError('loginError', '');
    setBusy(btn, true, 'Signing in…');
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { password }, allow401: true });
      agent = data.agent;
      csrf = data.csrfToken;
      $('sessionNote').textContent = 'Session valid for up to ' + (data.sessionHours || 12) + ' hours';
      $('loginPassword').value = '';
      showApp();
      await loadConsents({ initial: true });
      toast('Signed in to the team desk.', 'ok');
    } catch (e) {
      setError('loginError', e.message || 'Could not sign in.');
    } finally {
      setBusy(btn, false);
    }
  }

  async function logout() {
    const btn = $('btnLogout');
    setBusy(btn, true, 'Signing out…');
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* already gone */ }
    setBusy(btn, false);
    showLogin('You have been signed out.');
  }

  // ── Consent records ─────────────────────────────────────────────────────
  async function loadConsents(options) {
    const opts = options || {};
    const before = new Map(consents.map((r) => [r.id, r.status]));
    try {
      const data = await api('/api/consents');
      consents = data.consents || [];
      if (!opts.silent) {
        const signedNow = consents.filter((r) => r.status === 'signed' && before.get(r.id) && before.get(r.id) !== 'signed');
        if (signedNow.length) {
          toast('Client signed: ' + signedNow.map((r) => r.clientName).join(', '), 'ok');
          if (signedNow.some((r) => r.id === activeId)) fillFormFromRecord(activeRecord());
        }
      }
      renderRecords();
      renderPreview();
      renderLinkPanel();
      $('btnExportAll').disabled = !consents.some((r) => r.status === 'signed');
    } catch (e) {
      if (!opts.silent) toast(e.message || 'Could not load consent records.', 'err');
    }
  }

  function fillFormFromRecord(record) {
    if (!record) return;
    $('clientName').value = record.clientName || '';
    $('idNumber').value = record.idNumber || '';
    $('phone').value = record.phone || '';
    $('email').value = record.email || '';
    $('reference').value = record.reference || '';
  }

  function selectConsent(id, fillForm) {
    activeId = id;
    const record = activeRecord();
    if (record && fillForm) fillFormFromRecord(record);
    if (record && record.status !== 'signed') clearSignature();
    renderPreview();
    renderLinkPanel();
    renderRecords();
  }

  function renderRecords() {
    const body = $('recordsBody');
    const query = $('searchRecords').value;
    const status = $('filterRecords').value;
    const rows = C.filterRecords(consents, { query, status });
    body.textContent = '';
    $('recordsEmpty').hidden = rows.length > 0;
    $('recordsCount').textContent = consents.length + (consents.length === 1 ? ' consent request' : ' consent requests')
      + (rows.length !== consents.length ? ' · showing ' + rows.length : '');

    rows.forEach((record) => {
      const tr = document.createElement('tr');
      if (record.id === activeId) tr.className = 'selected';

      const created = document.createElement('td');
      created.textContent = C.formatDate(record.createdAt);

      const client = document.createElement('td');
      const name = document.createElement('strong');
      name.textContent = record.clientName || '—';
      client.appendChild(name);
      if (record.reference) {
        const ref = document.createElement('div');
        ref.className = 'muted small';
        ref.textContent = record.reference;
        client.appendChild(ref);
      }

      const contact = document.createElement('td');
      if (record.phone) {
        const p = document.createElement('div');
        p.textContent = record.phone;
        contact.appendChild(p);
      }
      if (record.email) {
        const e = document.createElement('div');
        e.className = 'muted small';
        e.textContent = record.email;
        contact.appendChild(e);
      }
      if (!contact.textContent) contact.textContent = '—';

      const statusCell = document.createElement('td');
      const pill = document.createElement('span');
      statusPill(pill, record.status);
      statusCell.appendChild(pill);

      const signed = document.createElement('td');
      signed.textContent = record.signedAt ? C.formatDateTime(record.signedAt) : '—';

      const actions = document.createElement('td');
      actions.className = 'actions';

      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'row-btn';
      view.textContent = 'View';
      view.addEventListener('click', () => selectConsent(record.id, true));
      actions.appendChild(view);

      if (links.has(record.id) && record.status === 'pending') {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'row-btn';
        copy.textContent = 'Copy link';
        copy.addEventListener('click', () => {
          selectConsent(record.id, false);
          copyLink(links.get(record.id));
        });
        actions.appendChild(copy);
      }

      if (record.status === 'signed' && record.hasPdf) {
        const pdf = document.createElement('button');
        pdf.type = 'button';
        pdf.className = 'row-btn primary';
        pdf.textContent = 'PDF';
        pdf.addEventListener('click', () => downloadPdf(record));
        actions.appendChild(pdf);
      }

      if (record.status === 'pending' || record.status === 'expired') {
        const renew = document.createElement('button');
        renew.type = 'button';
        renew.className = 'row-btn';
        renew.textContent = 'New link';
        renew.addEventListener('click', () => renewConsent(record));
        actions.appendChild(renew);
      }

      tr.append(created, client, contact, statusCell, signed, actions);
      body.appendChild(tr);
    });
  }

  function clearSignature() {
    sigRequestId++;
    sigLoadingForId = null;
    sigForId = null;
    if (sigObjectUrl) { URL.revokeObjectURL(sigObjectUrl); sigObjectUrl = null; }
    const img = $('signedImage');
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    img.hidden = true;
    $('signatureEmpty').hidden = false;
  }

  function renderPreview() {
    const record = activeRecord();
    const status = $('previewStatus');
    const download = $('btnDownloadActive');
    const renew = $('btnRenewActive');
    const empty = $('signatureEmpty');
    const img = $('signedImage');

    if (!record) {
      status.className = 'pill';
      status.textContent = 'No request';
      $('previewName').textContent = '—';
      $('previewId').textContent = '—';
      $('previewPhone').textContent = '—';
      $('previewEmail').textContent = '—';
      $('previewRef').textContent = '—';
      $('previewSignedAt').textContent = '—';
      $('previewCode').textContent = '—';
      $('previewHint').textContent = 'Generate a link, select a record, or wait for the client to sign.';
      download.disabled = true;
      renew.hidden = true;
      clearSignature();
      empty.textContent = "The client's signature will appear here automatically once they sign.";
      empty.hidden = false;
      return;
    }

    statusPill(status, record.status);
    $('previewName').textContent = record.clientName || '—';
    $('previewId').textContent = record.idNumber || '—';
    $('previewPhone').textContent = record.phone || '—';
    $('previewEmail').textContent = record.email || '—';
    $('previewRef').textContent = record.reference || '—';
    $('previewSignedAt').textContent = record.signedAt ? C.formatDateTime(record.signedAt) : '—';
    $('previewCode').textContent = record.verificationCode || '—';
    download.disabled = !(record.status === 'signed' && record.hasPdf);
    renew.hidden = !(record.status === 'pending' || record.status === 'expired');

    if (record.status === 'signed') {
      $('previewHint').textContent = 'Signed and archived on the server. Download the original PDF above.';
      if (sigForId === record.id) {
        empty.hidden = true;
        img.hidden = false;
      } else {
        empty.hidden = false;
        empty.textContent = 'Loading the captured signature…';
        loadSignature(record);
      }
    } else {
      clearSignature();
      empty.hidden = false;
      empty.textContent = record.status === 'expired'
        ? 'This link expired before it was signed. Use New link to send another.'
        : 'Waiting for the client to sign. This page checks automatically — you can leave it open.';
      $('previewHint').textContent = record.status === 'expired'
        ? 'Generate a fresh link to send to the client.'
        : 'The signature will appear here as soon as it is captured.';
    }
  }

  async function loadSignature(record) {
    if (!record || record.status !== 'signed' || sigForId === record.id || sigLoadingForId === record.id) return;
    const requestId = ++sigRequestId;
    sigLoadingForId = record.id;
    let objectUrl = null;
    try {
      const blob = await fetchBlob('/api/consents/' + encodeURIComponent(record.id) + '/signature');
      if (activeId !== record.id || requestId !== sigRequestId) return;
      objectUrl = URL.createObjectURL(blob);
      const preloadedImage = new Image();
      await new Promise((resolve, reject) => {
        preloadedImage.onload = resolve;
        preloadedImage.onerror = () => reject(new Error('The signature image could not be decoded.'));
        preloadedImage.src = objectUrl;
      });
      if (activeId !== record.id || requestId !== sigRequestId) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        return;
      }
      if (sigObjectUrl) URL.revokeObjectURL(sigObjectUrl);
      sigObjectUrl = objectUrl;
      objectUrl = null;
      sigForId = record.id;
      const img = $('signedImage');
      img.src = sigObjectUrl;
      img.hidden = false;
      $('signatureEmpty').hidden = true;
    } catch (e) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (activeId === record.id && requestId === sigRequestId) {
        const img = $('signedImage');
        img.removeAttribute('src');
        img.hidden = true;
        $('signatureEmpty').hidden = false;
        $('signatureEmpty').textContent = 'The signature image could not be loaded. The archived PDF is still available.';
      }
    } finally {
      if (sigLoadingForId === record.id && requestId === sigRequestId) sigLoadingForId = null;
    }
  }

  function renderLinkPanel() {
    const record = activeRecord();
    const link = record ? links.get(record.id) : '';
    const visible = !!(record && link && record.status === 'pending');
    $('linkPanel').hidden = !visible;
    if (!visible) {
      $('requestStatus').textContent = '';
      return;
    }
    $('consentLink').value = link;
    $('requestStatus').className = 'status-line';
    $('requestStatus').textContent = 'Waiting for the client to sign. Link expires '
      + C.formatDateTime(record.expiresAt) + '.';
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  async function generate(event) {
    event.preventDefault();
    setError('requestError', '');
    const body = {
      clientName: $('clientName').value.trim(),
      idNumber: $('idNumber').value.trim(),
      phone: $('phone').value.trim(),
      email: $('email').value.trim(),
      reference: $('reference').value.trim(),
    };
    if (!body.clientName) return setError('requestError', 'Enter the client full name.');
    if (!body.idNumber) return setError('requestError', 'Enter the client ID number.');
    if (!body.phone && !body.email) return setError('requestError', 'Enter a WhatsApp number or an email address.');
    if (body.email && !C.isEmail(body.email)) return setError('requestError', 'Enter a valid email address.');

    const btn = $('btnGenerate');
    setBusy(btn, true, 'Creating link…');
    try {
      const data = await api('/api/consents', { method: 'POST', body });
      const record = Object.assign({ status: 'pending', hasPdf: false, hasSignature: false }, data.consent);
      consents.unshift(record);
      links.set(record.id, data.consentLink);
      activeId = record.id;
      fillFormFromRecord(record);
      renderRecords();
      renderPreview();
      renderLinkPanel();
      $('requestStatus').className = 'status-line ok';
      $('requestStatus').textContent = 'Secure link created. Copy it or send it to the client.';
      await copyLink(data.consentLink, true);
      toast('Consent link created for ' + record.clientName, 'ok');
    } catch (e) {
      setError('requestError', e.message || 'Could not create the consent link.');
    } finally {
      setBusy(btn, false);
    }
  }

  async function copyLink(link, quiet) {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      if (quiet) $('requestStatus').textContent = 'Secure link created and copied. Send it to the client.';
      else toast('Consent link copied.', 'ok');
    } catch (e) {
      const input = $('consentLink');
      input.value = link;
      input.focus();
      input.select();
      try { document.execCommand('copy'); } catch (err) { /* leave it selected */ }
      toast('The link is selected — copy it from the box.', 'ok');
    }
  }

  function currentLink() {
    const record = activeRecord();
    if (record && links.has(record.id)) return links.get(record.id);
    return $('consentLink').value.trim();
  }

  function sendWhatsApp() {
    const record = activeRecord();
    const link = currentLink();
    if (!record || !link) { toast('Generate or renew the consent link first.', 'err'); return; }
    const digits = C.normalizeZaPhone(record.phone);
    if (!digits) { toast("Enter the client's WhatsApp number first.", 'err'); return; }
    const url = C.whatsappUrl(digits, C.whatsappMessage(record, link));
    let opened = false;
    try {
      const w = window.open(url, '_blank');
      if (w) { try { w.opener = null; } catch (e) {} opened = true; }
    } catch (e) { opened = false; }
    $('requestStatus').className = 'status-line ' + (opened ? 'ok' : 'err');
    $('requestStatus').textContent = opened
      ? 'WhatsApp opened with the consent link — press Send there.'
      : 'The browser blocked the WhatsApp window. Use Copy and send the link yourself.';
  }

  function sendEmail() {
    const record = activeRecord();
    const link = currentLink();
    if (!record || !link) { toast('Generate or renew the consent link first.', 'err'); return; }
    if (!C.isEmail(record.email)) { toast("Enter the client's email address first.", 'err'); return; }
    const url = C.mailComposeUrl('gmail', record.email, 'Khusela consent — please sign', C.emailMessage(record, link));
    let opened = false;
    try {
      const w = window.open(url, '_blank');
      if (w) { try { w.opener = null; } catch (e) {} opened = true; }
    } catch (e) { opened = false; }
    $('requestStatus').className = 'status-line ' + (opened ? 'ok' : 'err');
    $('requestStatus').textContent = opened
      ? 'Your email window is open with the link for ' + record.email + ' — press Send there.'
      : 'The browser blocked the email window. Use Copy and send the link yourself.';
  }

  async function renewConsent(record) {
    if (!record) return;
    try {
      const data = await api('/api/consents/' + encodeURIComponent(record.id) + '/renew', { method: 'POST' });
      record.status = 'pending';
      record.createdAt = data.consent.createdAt;
      record.expiresAt = data.consent.expiresAt;
      record.signedAt = null;
      record.verificationCode = null;
      record.hasPdf = false;
      links.set(record.id, data.consentLink);
      activeId = record.id;
      fillFormFromRecord(record);
      clearSignature();
      renderRecords();
      renderPreview();
      renderLinkPanel();
      await copyLink(data.consentLink, true);
      toast('A fresh consent link was created for ' + record.clientName, 'ok');
    } catch (e) {
      toast(e.message || 'Could not create a new link.', 'err');
    }
  }

  async function downloadPdf(record) {
    if (!record || record.status !== 'signed') return;
    try {
      const blob = await fetchBlob('/api/consents/' + encodeURIComponent(record.id) + '/pdf');
      downloadBlob(blob, 'Khusela-Consent-' + C.sanitizeFilename(record.clientName) + '.pdf');
      toast('Archived consent PDF downloaded.', 'ok');
    } catch (e) {
      toast(e.message || 'Could not download the PDF.', 'err');
    }
  }

  async function downloadAll() {
    const btn = $('btnExportAll');
    setBusy(btn, true, 'Building backup…');
    try {
      const blob = await fetchBlob('/api/consents-export.pdf');
      downloadBlob(blob, 'Khusela-Signed-Consents.pdf');
      toast('All signed consents downloaded as one PDF.', 'ok');
    } catch (e) {
      toast(e.message || 'Could not build the backup PDF.', 'err');
    } finally {
      setBusy(btn, false);
    }
  }

  // ── Polling / lifecycle ─────────────────────────────────────────────────
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && agent) loadConsents({ silent: true });
    }, 12000);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function wire() {
    $('loginForm').addEventListener('submit', login);
    $('btnLogout').addEventListener('click', logout);
    $('consentForm').addEventListener('submit', generate);
    $('btnCopy').addEventListener('click', () => copyLink(currentLink()));
    $('btnWhatsApp').addEventListener('click', sendWhatsApp);
    $('btnEmail').addEventListener('click', sendEmail);
    $('btnRenewActive').addEventListener('click', () => renewConsent(activeRecord()));
    $('btnDownloadActive').addEventListener('click', () => downloadPdf(activeRecord()));
    $('btnExportAll').addEventListener('click', downloadAll);
    $('btnRefresh').addEventListener('click', () => loadConsents({}));
    $('searchRecords').addEventListener('input', renderRecords);
    $('filterRecords').addEventListener('change', renderRecords);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && agent) loadConsents({ silent: true });
    });
  }

  wire();
  boot();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
    });
  }
})();
