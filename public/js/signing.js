// Client signing page. The token comes from /sign/<token>; it is a one-time
// capability and the only thing this page sends is the drawn signature.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const token = location.pathname.split('/').filter(Boolean).pop() || '';
  const canvas = $('signaturePad');
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let drawn = false;
  let busy = false;
  let done = false;
  let dpr = 1;

  function showError(message) {
    $('loading').hidden = true;
    $('signForm').hidden = true;
    $('doneBox').hidden = true;
    $('errorText').textContent = message || 'This consent link could not be opened.';
    $('errorBox').hidden = false;
  }

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#102a5c';
  }

  function clearPad() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    drawn = false;
    canvas.parentElement.classList.remove('drawn');
    $('btnSign').disabled = true;
    $('status').textContent = '';
    $('status').className = 'status';
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function down(event) {
    if (done || busy) return;
    event.preventDefault();
    drawing = true;
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* older browsers */ }
  }

  function move(event) {
    if (!drawing || done || busy) return;
    event.preventDefault();
    const p = point(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!drawn) {
      drawn = true;
      canvas.parentElement.classList.add('drawn');
      $('btnSign').disabled = false;
    }
  }

  function up() {
    drawing = false;
  }

  async function submit() {
    if (!drawn || busy || done) return;
    busy = true;
    $('btnSign').disabled = true;
    $('btnClear').disabled = true;
    $('status').className = 'status';
    $('status').textContent = 'Recording your consent securely…';
    try {
      const res = await fetch('/api/sign/' + encodeURIComponent(token) + '/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ signature: canvas.toDataURL('image/png') }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Your consent could not be recorded. Please try again.');
      done = true;
      clearPad();
      $('signForm').hidden = true;
      $('doneBox').hidden = false;
      $('doneText').textContent = data.message || 'Your consent has been signed and archived securely. You can close this window.';
      $('doneCode').textContent = data.verificationCode ? 'Verification code: ' + data.verificationCode : '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      $('status').className = 'status err';
      $('status').textContent = e.message || 'Your consent could not be recorded. Please try again.';
      $('btnSign').disabled = false;
      $('btnClear').disabled = false;
    } finally {
      busy = false;
    }
  }

  async function load() {
    if (!token) { showError('This consent link is incomplete.'); return; }
    try {
      const res = await fetch('/api/sign/' + encodeURIComponent(token), { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data.error || 'This consent link could not be opened.'); return; }

      $('clientName').textContent = data.clientName || 'client';
      $('consentText').textContent = data.consentText;
      $('expiresAt').textContent = data.expiresAt
        ? new Date(data.expiresAt).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })
        : 'the date shown on your link';
      $('loading').hidden = true;
      $('signForm').hidden = false;

      // The form starts hidden, so the canvas measured 0 x 0 at parse time.
      // Measure again once it is visible, and on resize.
      sizeCanvas();
      window.addEventListener('resize', () => { if (!drawn) sizeCanvas(); });

      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('pointerleave', up);
      $('btnClear').addEventListener('click', clearPad);
      $('btnSign').addEventListener('click', submit);
    } catch (e) {
      showError('Could not reach the consent service. Please check your connection and open the link again.');
    }
  }

  load();
})();
