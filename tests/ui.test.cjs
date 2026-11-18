const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const privacy = require('../privacy.js');
const logger = require('../override-log.js');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const code = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean).join('\n');

function app() {
  class Element {
    constructor() {
      this.value = ''; this.textContent = ''; this.innerHTML = ''; this.className = ''; this.disabled = false; this.checked = false;
      this.dataset = {}; this.options = []; this.children = [];
      const set = new Set();
      this.classList = { add: (...args) => args.forEach(value => set.add(value)), remove: (...args) => args.forEach(value => set.delete(value)), toggle: (value, yes) => yes ? set.add(value) : set.delete(value), contains: value => set.has(value) };
    }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    focus() {} scrollIntoView() {} addEventListener() {} remove() {} click() {}
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const selects = [];
  for (const match of html.matchAll(/<select([^>]+)>([\s\S]*?)<\/select>/g)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    const element = id ? elements.get(id) : new Element();
    element.options = [...match[2].matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/g)].map(option => ({ value: option[1] ?? option[2] }));
    for (const data of match[1].matchAll(/data-(\w+)="([^"]+)"/g)) element.dataset[data[1]] = data[2];
    if (element.dataset.key) selects.push(element);
  }
  const storage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
  const session = storage(); session.setItem('hx_qa_key', 'FAKE_TEST_CREDENTIAL');
  const requests = [], corrections = [], alerts = [];
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), createElement: () => new Element(), body: new Element(),
      querySelector: selector => selects.find(element => selector === `[data-key="${element.dataset.key}"]`) || null,
      querySelectorAll: selector => selector === '.score-select' ? selects : selector.startsWith('[data-section=') ? selects.filter(element => selector.includes('"' + element.dataset.section + '"')) : [] },
    HXPrivacy: privacy, HXOverrideLog: { ...logger, createBrowserTransport: () => ({ send: async entry => { corrections.push(entry); }, check: async eventId => ({ status: 'success', eventId }) }) },
    crypto: { randomUUID }, sessionStorage: session, localStorage: storage(), window: { addEventListener() {}, scrollTo() {} },
    alert: value => alerts.push(value), confirm: () => true, setTimeout, URL, Blob,
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ content: [{ text: '{"scores":{}}' }] }) }; }
  });
  vm.runInContext(code, context);
  return { context, elements, selects, requests, corrections, alerts };
}
test('privacy review is available without a provider key and cannot submit unchecked', () => {
  const ui = app(); ui.context.clearKey(); ui.context.loadDemo(); ui.context.openPrivacyReview();
  assert.ok(ui.elements.get('anonPreview').value.includes('[EMAIL REMOVED]'));
  assert.ok(!ui.elements.get('anonPreview').value.includes('Patricia'));
  ui.context.confirmAndScore();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.elements.get('confirmScoreBtn').disabled, true);
});
test('scorer receives precisely the approved edited text, with no original thread or extra fields', async () => {
  const ui = app(); ui.context.loadDemo(); ui.context.openPrivacyReview();
  ui.elements.get('anonPreview').value = 'ONLY THE REVIEWED THREAD. Refund £20.';
  ui.elements.get('privacyConfirmed').checked = true;
  ui.context.confirmAndScore();
  assert.equal(ui.requests.length, 1);
  const prompt = ui.requests[0].body.messages[0].content;
  assert.ok(prompt.includes('ONLY THE REVIEWED THREAD. Refund £20.'));
  assert.ok(!prompt.includes('patricia.hammond') && !prompt.includes('Megan White'));
  assert.equal(ui.elements.get('emailChain').value, 'ONLY THE REVIEWED THREAD. Refund £20.');
  assert.equal(ui.elements.get('anonPreview').value, '');
});
test('editing the preview cancels approval and extra identifiers must be applied', () => {
  const ui = app(); ui.context.loadDemo(); ui.context.openPrivacyReview();
  ui.elements.get('privacyConfirmed').checked = true; ui.context.resetPrivacyConfirmation();
  assert.equal(ui.elements.get('privacyConfirmed').checked, false);
  ui.elements.get('extraIdentifiers').value = 'Rose Cottage'; ui.elements.get('privacyConfirmed').checked = true;
  ui.context.confirmAndScore(); assert.equal(ui.requests.length, 0);
  ui.elements.get('anonPreview').value = 'Manual edit. Rose Cottage.'; ui.context.redactMore();
  assert.equal(ui.elements.get('anonPreview').value, 'Manual edit. [DETAIL REMOVED].');
  assert.equal(ui.elements.get('privacyConfirmed').checked, false);
});
test('calling the scorer without a reviewed thread opens privacy review and sends nothing', async () => {
  const ui = app(); ui.context.loadDemo(); await ui.context.handleScore();
  assert.equal(ui.requests.length, 0);
  assert.ok(ui.elements.get('anonPreview').value.includes('[EMAIL REMOVED]'));
});
test('a new manual scorecard never logs against an earlier AI suggestion', () => {
  const ui = app(); ui.context.loadDemo(); ui.context.clearScores();
  ui.context.applyAIScores({ scores: { empathy: { score: 2, reasoning: 'Warm reply' } } });
  ui.context.manualOnly();
  const empathy = ui.selects.find(element => element.dataset.key === 'empathy'); empathy.value = '1'; ui.context.updateScore(empathy);
  assert.equal(ui.corrections.length, 0);
});
test('correction baseline, audit identity and duplicate selections are handled correctly', () => {
  const ui = app(); ui.context.loadDemo(); ui.context.clearScores();
  ui.context.applyAIScores({ scores: { empathy: { score: 2, reasoning: 'Warm reply' } } });
  const empathy = ui.selects.find(element => element.dataset.key === 'empathy'); empathy.value = '1'; ui.context.updateScore(empathy); ui.context.updateScore(empathy);
  assert.equal(ui.corrections.length, 1);
  ui.elements.get('caseNum').value = 'A DIFFERENT CASE'; empathy.value = '2'; ui.context.updateScore(empathy);
  assert.equal(ui.corrections.length, 2);
  assert.equal(ui.corrections[0].caseId, ui.corrections[1].caseId);
  assert.equal(ui.corrections[0].auditId, ui.corrections[1].auditId);
  assert.notEqual(ui.corrections[0].eventId, ui.corrections[1].eventId);
});
test('model explanations remain inert and invalid suggested scores are ignored', () => {
  const ui = app(); ui.context.loadDemo(); ui.context.clearScores();
  const payload = '<img src=x onerror=alert(1)>';
  ui.context.applyAIScores({ scores: { empathy: { score: 2, reasoning: payload }, grammar: { score: 99, reasoning: 'Invalid' } } });
  assert.equal(ui.elements.get('reason-empathy').textContent, 'AI: ' + payload);
  assert.equal(ui.elements.get('reason-empathy').innerHTML, '');
  assert.equal(ui.selects.find(element => element.dataset.key === 'grammar').value, '');
});
