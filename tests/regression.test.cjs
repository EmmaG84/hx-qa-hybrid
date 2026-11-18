const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const privacy = require('../privacy.js');
const logger = require('../override-log.js');

test('full quoted thread removes contact details and links repeat names consistently', () => {
  const text = 'From: Emma Greenwood <emma.greenwood@example.com>\nTo: Patricia Hammond <patricia@example.com>\n\nDear Patricia,\nYour £20 refund is due in 3 to 5 days.\n\nKind regards,\nEmma Greenwood\n\n> From: Patricia Hammond <patricia@example.com>\n> Address: Flat 2, 12 Example Road\n> Bristol\n> BS1 1AA\n> Telephone: +44 (0)7700 900123';
  const { clean } = privacy.redact(text);
  for (const identifier of ['Emma', 'Greenwood', 'Patricia', 'Hammond', '@example', 'Example Road', 'Bristol', 'BS1', '7700']) assert.ok(!clean.includes(identifier), identifier);
  assert.ok(clean.includes('£20 refund is due in 3 to 5 days'));
  assert.ok(clean.includes('> From:'));
  const salutation = clean.match(/Dear (\[PERSON \d+\])/)[1];
  assert.ok(clean.includes('To: ' + salutation));
  assert.ok(clean.includes('> From: ' + salutation));
});

for (const phone of ['07700 900123', '020 7946 0999', '+44 7700 900123', '+44 (0)7700 900123', '0044 7700 900123', '(07700) 900123', '+353 85 123 4567']) {
  test('telephone format removed: ' + phone, () => assert.ok(privacy.redact('Telephone: ' + phone).clean.includes('[PHONE REMOVED]')));
}
for (const address of ['12 Example Road, Bristol, BS1 1AA', 'Flat 2, 12 Example Road\nBristol\nBS1 1AA', 'Address: Rose Cottage\nHigh Street\nCanterbury\nCT1 2AA', 'Address:\nRose Cottage\nHigh Street\nCanterbury\nCT1 2AA', 'Address: The Old Barn, Example Village']) {
  test('address removed: ' + address.split('\n')[0], () => {
    const result = privacy.redact(address + '\n\nMy refund is still missing.').clean;
    assert.ok(result.includes('[ADDRESS REMOVED]'));
    assert.ok(!result.includes('Example') && !result.includes('Cottage') && !result.includes('Canterbury') && !result.includes('Old Barn'));
    assert.ok(result.includes('My refund is still missing.'));
  });
}
test('Unicode, compound surnames and several recipients are redacted', () => {
  const clean = privacy.redact("From: Zoë O’Connor <zoe@example.com>\nCc: Jean-Luc Martin <j@example.com>, Mary Smith <m@example.com>\nDear Zoë and Mary,\nOur refund is late.").clean;
  for (const name of ['Zoë', 'O’Connor', 'Jean-Luc', 'Martin', 'Mary', 'Smith']) assert.ok(!clean.includes(name), name);
});
test('manual additions are literal, ignore case and keep existing preview edits', () => {
  const clean = privacy.redact('Reviewed edit. Unusual name mcdonald. Rose Cottage (Annexe). Ref ABC12345.', { extraIdentifiers: ['McDonald', 'Rose Cottage (Annexe)'] }).clean;
  assert.equal(clean, 'Reviewed edit. Unusual name [DETAIL REMOVED]. [DETAIL REMOVED]. Ref ABC12345.');
});
test('supplier, destination, amount, dates and complaint evidence survive', () => {
  const text = 'The Radisson Blu Hotel at Heathrow Airport did not help. We went to Barcelona on 14 March. My husband’s 50th birthday was affected. Refund £20. Ref HX123456.';
  assert.equal(privacy.redact(text).clean, text);
});
test('standalone postcodes and names in labelled fields are redacted', () => {
  const clean = privacy.redact('Customer name: Daniel Smith\nDear Daniel,\nPostcode: sw1a 1aa\nRefund missing.').clean;
  assert.ok(!clean.includes('Daniel') && !clean.includes('Smith') && !clean.includes('sw1a'));
});

function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const entry = () => ({ eventId: randomUUID(), auditId: randomUUID(), date: '18/11/2026', recordedAt: new Date().toISOString(), agent: 'Synthetic agent', reviewer: 'Synthetic reviewer', caseId: 'TEST-ONLY', criterion: 'Empathy', aiScore: '2', humanScore: '1', maxScore: '2' });
test('opaque send completion alone never becomes saved', async () => {
  const store = storage();
  const queue = logger.createQueue({ storage: store, send: async () => ({ type: 'opaque' }), check: async () => ({ status: 'pending' }), pause: async () => {} });
  await queue.enqueue(entry());
  assert.equal(queue.snapshot().confirmed, 0);
  assert.equal(queue.snapshot().pending[0].state, 'unconfirmed');
  assert.equal(JSON.parse(store.getItem(logger.STORAGE_KEY)).length, 1);
});
test('only receipt for the exact event confirms a saved correction', async () => {
  const queue = logger.createQueue({ storage: storage(), send: async () => {}, check: async () => ({ status: 'success', eventId: randomUUID() }), pause: async () => {} });
  await queue.enqueue(entry());
  assert.equal(queue.snapshot().confirmed, 0);
});
test('offline correction is recoverable after reload and retry uses its existing ID', async () => {
  const store = storage();
  const data = entry();
  const offline = logger.createQueue({ storage: store, send: async () => { throw new Error('Offline'); }, check: async () => {} });
  await offline.enqueue(data);
  assert.equal(offline.snapshot().pending[0].state, 'failed');
  let sent;
  const online = logger.createQueue({ storage: store, send: async value => { sent = value; }, check: async eventId => ({ status: 'success', eventId }) });
  await online.retry();
  assert.equal(sent.eventId, data.eventId);
  assert.equal(online.snapshot().confirmed, 1);
  assert.equal(online.snapshot().pending.length, 0);
  assert.equal(store.getItem(logger.STORAGE_KEY), null);
});
test('duplicate retry clicks never send the same outstanding event concurrently', async () => {
  let finish;
  let calls = 0;
  const queue = logger.createQueue({ storage: storage(), send: async () => { calls++; await new Promise(resolve => { finish = resolve; }); }, check: async eventId => ({ status: 'success', eventId }) });
  const job = queue.enqueue(entry());
  await queue.retry();
  assert.equal(calls, 1);
  finish(); await job;
});
test('storage failure keeps correction in memory and signals recovery is unavailable', async () => {
  const queue = logger.createQueue({ storage: { getItem: () => null, setItem: () => { throw new Error('Full'); } }, send: async () => { throw new Error('Offline'); }, check: async () => {} });
  await queue.enqueue(entry());
  assert.equal(queue.snapshot().storageError, true);
  assert.equal(queue.snapshot().pending.length, 1);
});
test('pending storage and CSV never include an accidentally supplied email thread or key', async () => {
  const store = storage();
  const queue = logger.createQueue({ storage: store, send: async () => { throw new Error(); }, check: async () => {} });
  await queue.enqueue({ ...entry(), email: 'PRIVATE THREAD', apiKey: 'PRIVATE KEY', notes: 'PRIVATE NOTES' });
  const saved = store.getItem(logger.STORAGE_KEY);
  const csv = logger.toCSV(queue.snapshot().pending);
  assert.ok(!saved.includes('PRIVATE') && !csv.includes('PRIVATE'));
  assert.ok(logger.toCSV([{ ...entry(), agent: '=IMPORTXML("bad")' }]).includes("'=IMPORTXML"));
});
test('damaged prior recovery copy is left untouched', async () => {
  const store = storage(); store.setItem(logger.STORAGE_KEY, '{broken');
  const queue = logger.createQueue({ storage: store, send: async () => { throw new Error(); }, check: async () => {} });
  await queue.enqueue(entry());
  assert.equal(store.getItem(logger.STORAGE_KEY), '{broken');
  assert.equal(queue.snapshot().storageError, true);
  assert.equal(queue.snapshot().pending.length, 1);
});

function receiver() {
  const rows = [['Date', 'Agent', 'Case ID', 'Reviewer', 'Criterion', 'AI Score', 'Human Score', 'Max Score']];
  let failWrite = false;
  const sheet = {
    getLastRow: () => rows.length,
    getRange(row, col, count = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, index) => rows[row - 1 + offset]?.[col - 1 + index] ?? '')),
        setValues(values) { values.forEach((valuesRow, offset) => { rows[row - 1 + offset] ||= []; valuesRow.forEach((value, index) => { rows[row - 1 + offset][col - 1 + index] = value; }); }); },
        createTextFinder(id) { return { matchEntireCell: () => ({ findNext: () => rows.slice(row - 1, row - 1 + count).find(values => values[col - 1] === id) || null }) }; }
      };
    },
    appendRow(values) { if (failWrite) throw new Error('Write refused'); rows.push(values); }
  };
  const context = vm.createContext({ console: { error() {} }, Utilities: { getUuid: randomUUID },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'FICTIONAL_TEST_SHEET' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, hasLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {} },
    ContentService: { MimeType: { JSON: 'json', JAVASCRIPT: 'javascript' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8'), context);
  return { context, rows, setFailWrite: value => { failWrite = value; }, post: data => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text) };
}
test('receiver confirms only a committed row and retries append it once', () => {
  const server = receiver(); const data = entry();
  assert.equal(server.post(data).status, 'success');
  assert.equal(server.post(data).status, 'success');
  assert.equal(server.rows.length, 2);
  assert.equal(server.rows[1][8], data.eventId);
  assert.deepEqual(server.rows[0].slice(0, 8), ['Date', 'Agent', 'Case ID', 'Reviewer', 'Criterion', 'AI Score', 'Human Score', 'Max Score']);
});
test('receiver write failure never confirms a save', () => {
  const server = receiver(); server.setFailWrite(true);
  assert.equal(server.post(entry()).status, 'error');
  assert.equal(server.rows.length, 1);
});
test('receipt endpoint returns no personal data and never writes', () => {
  const server = receiver(); const data = entry(); server.post(data);
  const callback = 'hxOverrideStatus_' + 'a'.repeat(32);
  const reply = server.context.doGet({ parameter: { action: 'status', eventId: data.eventId, callback } }).text;
  assert.ok(reply.startsWith(callback + '('));
  assert.ok(reply.includes('success'));
  for (const value of ['Synthetic agent', 'Synthetic reviewer', 'TEST-ONLY', 'Empathy']) assert.ok(!reply.includes(value));
  assert.equal(server.rows.length, 2);
  assert.ok(!server.context.doGet({ parameter: { action: 'status', eventId: data.eventId, callback: 'alert(1)//' } }).text.includes('alert'));
});
test('unknown receipt and invalid scores cannot produce false confirmation', () => {
  const server = receiver();
  assert.equal(JSON.parse(server.context.doGet({ parameter: { action: 'status', eventId: randomUUID() } }).text).status, 'pending');
  for (const bad of [{ aiScore: null }, { aiScore: '' }, { humanScore: '' }, { maxScore: '99' }, { humanScore: 9 }, { criterion: 'Made up' }]) assert.equal(server.post({ ...entry(), ...bad }).status, 'error');
  assert.equal(server.rows.length, 1);
});
test('legacy browser tabs still save and sheet formula injection is neutralised', () => {
  const server = receiver(); const data = entry(); delete data.eventId; delete data.auditId;
  assert.equal(server.post({ ...data, agent: '=IMPORTXML("bad")' }).status, 'success');
  assert.equal(server.rows[1][1], "'=IMPORTXML(\"bad\")");
});
test('all shipped scripts parse and preview uses a textarea rather than email HTML', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  scripts.forEach(script => new vm.Script(script));
  assert.ok(/<textarea[^>]*id="anonPreview"/.test(html));
  assert.ok(!html.includes('preview.innerHTML'));
  assert.ok(!html.includes('reasonEl.innerHTML = `'));
  assert.ok(html.includes('handleScore(reviewedEmail)'));
  assert.ok(html.includes('resetPrivacyConfirmation()'));
});
