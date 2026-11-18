// Keep the existing deployment's execution identity and access restrictions.
const LOG_SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('LOG_SPREADSHEET_ID');
const LOG_SHEET_NAME = 'HX QA Override Log';
const EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LOG_CRITERIA = {
  'Subject title': [0, 0.5], 'Resolved quickly': [0, 1], 'Supplier agreements': [0, 2],
  'Paraphrased': [0, 1], 'Goodwill notes': [0, 0.5], 'Opening': [0, 1],
  'All areas addressed': [0, 1], 'Prevention steps': [0, 1], 'Positive close': [0, 1],
  'Empathy': [0, 1, 2], 'Spelling': [0, 0.5, 1], 'Grammar': [0, 0.5, 1],
  'Personalisation': [0, 1, 2], 'AI tone': [0, 0.5], 'UK English': [0, 0.5]
};

function jsonReply_(data, callback) {
  const json = JSON.stringify(data);
  return ContentService.createTextOutput(callback ? callback + '(' + json + ');' : json)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
function findEvent_(sheet, eventId) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  return sheet.getRange(2, 9, last - 1, 1).createTextFinder(eventId).matchEntireCell(true).findNext();
}
function safeText_(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > 200) throw new Error('Field too long');
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}
function doPost(e) {
  let lock;
  let eventId;
  try {
    const data = JSON.parse(e.postData.contents);
    const scores = LOG_CRITERIA[data.criterion];
    if (!scores || data.aiScore == null || data.aiScore === '' || data.humanScore == null || data.humanScore === '' ||
        !scores.includes(Number(data.aiScore)) ||
        !(data.humanScore === 'na' || scores.includes(Number(data.humanScore))) ||
        Number(data.maxScore) !== Math.max.apply(null, scores)) throw new Error('Invalid scores');
    // Old open tabs still work during rollout; new clients always provide UUIDs.
    eventId = data.eventId || Utilities.getUuid();
    if (!EVENT_ID.test(eventId) || (data.auditId && !EVENT_ID.test(data.auditId))) throw new Error('Invalid event ID');
    lock = LockService.getScriptLock();
    lock.waitLock(20000);
    const sheet = SpreadsheetApp.openById(LOG_SPREADSHEET_ID).getSheetByName(LOG_SHEET_NAME);
    if (!sheet) throw new Error('Missing log sheet');
    const headers = ['Event ID', 'Audit ID', 'Recorded at'];
    const current = sheet.getRange(1, 9, 1, 3).getValues()[0];
    if (current.some((value, index) => value !== '' && value !== headers[index])) throw new Error('Conflicting log columns');
    if (current.some(value => value === '')) sheet.getRange(1, 9, 1, 3).setValues([headers]);
    if (!findEvent_(sheet, eventId)) {
      sheet.appendRow([safeText_(data.date), safeText_(data.agent), safeText_(data.caseId),
        safeText_(data.reviewer), data.criterion, Number(data.aiScore),
        data.humanScore === 'na' ? 'na' : Number(data.humanScore), Number(data.maxScore),
        eventId, safeText_(data.auditId), new Date().toISOString()]);
      SpreadsheetApp.flush();
    }
    if (!findEvent_(sheet, eventId)) throw new Error('Could not verify saved row');
    return jsonReply_({ status: 'success', eventId: eventId });
  } catch (error) {
    console.error('Correction could not be saved: ' + error.message);
    return jsonReply_({ status: 'error', code: 'SAVE_FAILED', eventId: EVENT_ID.test(eventId || '') ? eventId : null });
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}

function doGet(e) {
  const params = e && e.parameter || {};
  const callback = params.callback || '';
  if (callback && !/^hxOverrideStatus_[a-f0-9]{32}$/.test(callback)) return jsonReply_({ status: 'error' });
  if (params.action !== 'status' || !EVENT_ID.test(params.eventId || '')) return jsonReply_({ status: 'error' }, callback);
  try {
    const sheet = SpreadsheetApp.openById(LOG_SPREADSHEET_ID).getSheetByName(LOG_SHEET_NAME);
    // A read-only acknowledgement. Never return the row or any personal data.
    return jsonReply_({ status: sheet && findEvent_(sheet, params.eventId) ? 'success' : 'pending', eventId: params.eventId }, callback);
  } catch (_) { return jsonReply_({ status: 'error', eventId: params.eventId }, callback); }
}
