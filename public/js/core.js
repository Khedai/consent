// Small pure helpers shared by the agent desk and its Node tests.
// No DOM and no network here.
(function () {
  'use strict';

  const CONSENT_TEXT = 'I hereby confirm that i give Khusela Debt Management permission to access, obtain, process and use my credit and personal information in accordance to their mandate.';
  const COMPANY = 'Khusela Debt Management';
  const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

  function normalizeZaPhone(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/^(00|\+)/, '');
    s = s.replace(/\D/g, '');
    if (!s) return '';
    if (/^0\d{9}$/.test(s)) return '27' + s.slice(1);
    return (s.length >= 10 && s.length <= 15) ? s : '';
  }

  function isEmail(value) {
    return EMAIL_RE.test(String(value || '').trim());
  }

  function whatsappUrl(phoneDigits, text) {
    return 'https://wa.me/' + phoneDigits + '?text=' + encodeURIComponent(text);
  }

  function mailComposeUrl(webmail, addr, subject, body) {
    const enc = encodeURIComponent;
    const kind = String(webmail || 'gmail').toLowerCase();
    if (kind === 'outlook') {
      return 'https://outlook.live.com/mail/0/deeplink/compose?to=' + enc(addr)
        + '&subject=' + enc(subject) + '&body=' + enc(body);
    }
    if (kind === 'gmail') {
      return 'https://mail.google.com/mail/?view=cm&to=' + enc(addr)
        + '&su=' + enc(subject) + '&body=' + enc(body);
    }
    return 'mailto:' + enc(addr) + '?subject=' + enc(subject) + '&body=' + enc(body);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: '2-digit' });
  }

  function statusLabel(status) {
    if (status === 'signed') return 'Signed';
    if (status === 'expired') return 'Expired';
    return 'Waiting';
  }

  function statusClass(status) {
    if (status === 'signed') return 'ok';
    if (status === 'expired') return 'bad';
    return 'wait';
  }

  function sanitizeFilename(name) {
    const out = String(name || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    return out || 'client';
  }

  function whatsappMessage(record, link) {
    return 'Hi ' + (record.clientName || 'there') + ', please review and sign your consent for '
      + COMPANY + ' here: ' + link + '\n\nIt only takes a moment, and the link can be used once.';
  }

  function emailMessage(record, link) {
    return 'Hi ' + (record.clientName || 'there') + ',\n\n'
      + 'Please review and sign your consent for ' + COMPANY + ' here:\n\n'
      + link + '\n\n'
      + 'The link is unique to you and can be used once. Open it on your own device, read the consent '
      + 'statement, draw your signature and press Submit consent.\n\nThank you.';
  }

  function filterRecords(records, options) {
    const query = String((options && options.query) || '').trim().toLowerCase();
    const status = String((options && options.status) || 'all');
    return (records || []).filter((r) => {
      if (status === 'signed' && r.status !== 'signed') return false;
      if (status === 'pending' && r.status !== 'pending') return false;
      if (!query) return true;
      const haystack = [r.clientName, r.idNumber, r.phone, r.email, r.reference].join(' ').toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  }

  const api = {
    CONSENT_TEXT, COMPANY, EMAIL_RE,
    normalizeZaPhone, isEmail, whatsappUrl, mailComposeUrl,
    formatDateTime, formatDate, statusLabel, statusClass, sanitizeFilename,
    whatsappMessage, emailMessage, filterRecords,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.ConsentCore = api;
})();
