// Signed consent PDFs.
//
// The PDF is produced on the server at the moment the client signs and its
// bytes are stored with the consent row. Downloading later returns that exact
// archived document, not a fresh rendering, so the backup cannot drift away from
// what was signed. The verification code is a SHA-256 over the identity of the
// record and its signature image; it is printed on the PDF and stored beside it.
import PDFDocument from 'pdfkit';
import crypto from 'crypto';

const INK = '#102a5c';
const MUTED = '#4c5a70';
const LINE = '#cbd5e1';
const PAPER = '#f8fafc';
const GREEN = '#166534';

export const CONSENT_TEXT = 'I hereby confirm that i give Khusela Debt Management permission to access, obtain, process and use my credit and personal information in accordance to their mandate.';

export const COMPANY = 'Khusela Debt Management';

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function signatureBuffer(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  try { return { type: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') }; } catch (e) { return null; }
}

export function verificationCode(row, signatureData) {
  const signatureHash = crypto.createHash('sha256')
    .update(signatureData || Buffer.alloc(0)).digest('hex');
  const canonical = [
    row.id, row.client_name, row.id_number, row.signed_at || '', row.created_at || '', signatureHash,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16).toUpperCase();
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('en-ZA');
}

function drawHeader(doc, title) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(COMPANY, { continued: false });
  doc.moveDown(0.2);
  doc.fillColor(MUTED).font('Helvetica').fontSize(10)
    .text('Registration and mandate: access to credit and personal information');
  doc.moveDown(0.8);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(title);
  doc.moveDown(0.5);
  doc.strokeColor(LINE).lineWidth(1).moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.8);
}

function detail(doc, label, value) {
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), { continued: true });
  doc.fillColor(INK).font('Helvetica').fontSize(10).text('  ' + (value || '—'));
}

function drawConsent(doc, row) {
  drawHeader(doc, 'CONSENT TO PROCESS PERSONAL AND CREDIT INFORMATION');

  detail(doc, 'Reference', row.reference || row.id);
  detail(doc, 'Client', row.client_name);
  detail(doc, 'ID number', row.id_number);
  detail(doc, 'WhatsApp', row.phone);
  detail(doc, 'Email', row.email);
  detail(doc, 'Consent requested', formatDate(row.created_at));

  doc.moveDown(1);
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.roundedRect(left, doc.y, width, 96, 8).fillAndStroke(PAPER, LINE);
  const boxTop = doc.y;
  doc.fillColor(INK).font('Helvetica').fontSize(11.5)
    .text(row.consent_text || CONSENT_TEXT, left + 16, boxTop + 16, { width: width - 32, align: 'justify' });
  doc.y = boxTop + 96 + 14;

  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('SIGNATURE:');
  doc.moveDown(0.4);

  const sig = signatureBuffer(row.signature_data_url || row.signature_data);
  const sigTop = doc.y;
  if (sig) {
    try {
      doc.image(sig.buffer, left, sigTop, { fit: [260, 110] });
    } catch (e) { /* an unreadable image must not cost the rest of the document */ }
  } else {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10).text('No signature image stored.');
  }
  doc.y = sigTop + 118;
  doc.strokeColor(LINE).lineWidth(1).moveTo(left, doc.y).lineTo(left + 300, doc.y).stroke();
  doc.moveDown(0.2);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text('Signed by ' + (row.client_name || 'the client') + ' on ' + formatDate(row.signed_at));

  doc.moveDown(1.2);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('Record verification');
  doc.moveDown(0.3);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9);
  doc.text('Verification code: ' + (row.verification_code || '—'));
  doc.text('Record ID: ' + row.id);
  if (row.signed_ip) doc.text('Signing IP: ' + row.signed_ip);
  doc.text('The signed PDF is archived on the consent server and is downloadable by an authorised agent only.');

  doc.moveDown(1);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('DIGITALLY SIGNED AND RECORDED');
}

export async function buildConsentPdf(row) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 55, left: 50, right: 50 } });
  const done = toBuffer(doc);
  drawConsent(doc, row);
  doc.end();
  return done;
}

export async function buildConsentBundle(rows) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 55, left: 50, right: 50 } });
  const done = toBuffer(doc);
  if (!rows.length) {
    drawHeader(doc, 'SIGNED CONSENT BACKUP');
    doc.fillColor(MUTED).font('Helvetica').fontSize(11).text('No signed consent forms are on record yet.');
  } else {
    rows.forEach((row, index) => {
      if (index > 0) doc.addPage();
      drawConsent(doc, row);
    });
  }
  doc.end();
  return done;
}
