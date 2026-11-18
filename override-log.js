(function (root) {
  'use strict';
  const STORAGE_KEY = 'hx_qa_pending_corrections_v1';
  const FIELDS = ['eventId', 'auditId', 'date', 'recordedAt', 'agent', 'caseId', 'reviewer', 'criterion', 'aiScore', 'humanScore', 'maxScore'];
  const pick = entry => Object.fromEntries(FIELDS.map(key => [key, entry[key]]));

  function createQueue({ storage, send, check, onChange = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const pending = new Map();
    const running = new Set();
    let confirmed = 0;
    let storageError = false;
    let recoveryError = false;
    try {
      const stored = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(stored)) throw new Error('Invalid correction queue');
      stored.forEach(entry => {
        if (!/^[a-f0-9-]{36}$/i.test(entry.eventId || '')) throw new Error('Invalid correction');
        pending.set(entry.eventId, { ...pick(entry), state: 'unconfirmed' });
      });
    } catch (_) { recoveryError = true; }
    const snapshot = () => ({ pending: [...pending.values()].map(entry => ({ ...entry })), confirmed, storageError, recoveryError });
    const emit = () => onChange(snapshot());
    function persist() {
      try {
        // A damaged previous queue must not be silently overwritten.
        if (recoveryError) throw new Error('Stored corrections need recovery');
        const entries = [...pending.values()].map(pick);
        if (entries.length) storage.setItem(STORAGE_KEY, JSON.stringify(entries));
        else storage.removeItem(STORAGE_KEY);
        storageError = false;
      } catch (_) { storageError = true; }
      emit();
    }
    async function deliver(eventId) {
      const entry = pending.get(eventId);
      if (!entry || running.has(eventId)) return;
      running.add(eventId);
      entry.state = 'saving';
      emit();
      try {
        // Reusing the same event ID makes retries safe at the receiver.
        await send(pick(entry));
        let acknowledged = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          let reply;
          try { reply = await check(eventId); } catch (_) { /* Keep the correction until a valid receipt arrives. */ }
          if (reply?.eventId === eventId && reply.status === 'success') { acknowledged = true; break; }
          if (attempt < 2) await pause(600 * (attempt + 1));
        }
        if (acknowledged) { pending.delete(eventId); confirmed++; }
        else entry.state = 'unconfirmed';
      } catch (_) { entry.state = 'failed'; }
      finally { running.delete(eventId); persist(); }
    }
    function enqueue(data) {
      const entry = { ...pick(data), state: 'queued' };
      if (pending.has(entry.eventId) || !/^[a-f0-9-]{36}$/i.test(entry.eventId || '')) throw new Error('Invalid or duplicate correction ID');
      pending.set(entry.eventId, entry);
      persist();
      return deliver(entry.eventId);
    }
    const retry = () => Promise.all([...pending.keys()].map(deliver));
    emit();
    return { enqueue, retry, snapshot };
  }

  function createBrowserTransport(url) {
    return {
      async send(entry) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          // The existing Apps Script accepts a simple POST.
          // An opaque response is never treated as proof of a saved row.
          await fetch(url, { method: 'POST', mode: 'no-cors', credentials: 'omit',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(entry), signal: controller.signal });
        } finally { clearTimeout(timer); }
      },
      check(eventId) {
        return new Promise((resolve, reject) => {
          const callback = 'hxOverrideStatus_' + crypto.randomUUID().replace(/-/g, '');
          const script = document.createElement('script');
          const statusUrl = new URL(url);
          statusUrl.searchParams.set('action', 'status');
          statusUrl.searchParams.set('eventId', eventId);
          statusUrl.searchParams.set('callback', callback);
          script.src = statusUrl.href;
          script.referrerPolicy = 'no-referrer';
          const cleanup = () => { clearTimeout(timer); script.remove(); delete root[callback]; };
          const timer = setTimeout(() => { cleanup(); reject(new Error('No save confirmation')); }, 5000);
          root[callback] = reply => { cleanup(); resolve(reply); };
          script.onerror = () => { cleanup(); reject(new Error('Could not check the shared log')); };
          // This GET only returns the saved state of an unpredictable event ID.
          // Scores, names, case references and email content are never in its URL or response.
          document.head.appendChild(script);
        });
      }
    };
  }

  function toCSV(entries) {
    const cell = value => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return [FIELDS, ...entries.map(entry => FIELDS.map(field => entry[field]))].map(row => row.map(cell).join(',')).join('\r\n');
  }
  root.HXOverrideLog = { createQueue, createBrowserTransport, toCSV, STORAGE_KEY };
  if (typeof module !== 'undefined') module.exports = root.HXOverrideLog;
})(typeof window === 'undefined' ? globalThis : window);
