(function (root) {
  'use strict';
  const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[\dA-Z]?\s?\d[A-Z]{2})\b/gi;
  const NAME_WORD = "[\\p{Lu}][\\p{L}\\p{M}'’.-]*";
  const NAME = NAME_WORD + '(?:[ \\t]+' + NAME_WORD + '){0,3}';
  const NOT_PERSON = /\b(?:team|support|service|services|airport|hotel|parking|lounge|transfers|complaints?|bookings?|refunds?|customer|experience|holiday|extras|reception|office|department|there|everyone|all|sir|madam)\b/i;
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function redact(text, options = {}) {
    const removed = [];
    let clean = String(text || '').replace(/\r\n?/g, '\n');
    const record = (value, type, replacement) => {
      if (!removed.some(item => item.value === value && item.type === type)) removed.push({ value, type });
      return replacement;
    };
    const candidates = new Set();
    const addName = value => {
      const name = value.trim().replace(/^["']|["',;:]$/g, '').trim();
      if (name && name.length <= 90 && !NOT_PERSON.test(name) &&
          new RegExp('^(?:(?:Mr|Mrs|Ms|Miss|Dr|Mx)\\.?[ \\t]+)?' + NAME + '$', 'u').test(name)) candidates.add(name);
    };
    // Names are inferred locally from the whole thread, including quoted headers.
    for (const match of clean.matchAll(/^[ \t>]*(?:from|to|cc|bcc|reply-to):[ \t]*(.+)$/gim)) {
      match[1].split(/[;,]/).forEach(part => {
        const displayName = part.replace(EMAIL, '').replace(/<[^>]*>/g, '').replace(/[<>"()]/g, '').trim();
        addName(displayName);
      });
    }
    for (const match of clean.matchAll(/^[ \t>]*(?:Dear|Hi|Hello|Good morning|Good afternoon)[ \t]+([^\n,!]+)[,!]?[ \t]*$/gim)) {
      match[1].split(/\s+(?:and|&)\s+/i).forEach(addName);
    }
    const contexts = [
      new RegExp('^[ \\t>]*(?:Dear|Hi|Hello|Good morning|Good afternoon)[ \\t]+(' + NAME + ')(?=[,!:]|[ \\t]*$)', 'gmu'),
      new RegExp('^[ \\t>]*(?:Kind regards|Best regards|Regards|Best wishes|Many thanks|Yours sincerely|Yours faithfully|Thanks)[,!]?[ \\t]*\\n[ \\t>]*(' + NAME + ')(?=[,;]|[ \\t]*$)', 'gmu'),
      new RegExp('^[ \\t>]*(?:Name|Customer name|Passenger name|Lead passenger|Lead traveller|Guest name|Agent name|Full name):[ \\t]*(' + NAME + ')', 'gmu'),
      new RegExp('\\b(?:my name is|I am called|customer|passenger|guest|my partner|my husband|my wife|my daughter|my son)[ \\t]+(' + NAME + ')', 'gu'),
      new RegExp('\\b((?:Mr|Mrs|Ms|Miss|Dr|Mx)\\.?[ \\t]+' + NAME + ')', 'gu')
    ];
    contexts.forEach(pattern => { for (const match of clean.matchAll(pattern)) addName(match[1]); });
    (options.knownNames || []).forEach(name => {
      if (new RegExp('(?<![\\p{L}\\p{N}])' + escapeRegExp(name) + '(?![\\p{L}\\p{N}])', 'iu').test(clean)) addName(name);
    });
    const aliases = new Map();
    let person = 0;
    [...candidates].sort((a, b) => b.length - a.length).forEach(name => {
      const bare = name.replace(/^(?:Mr|Mrs|Ms|Miss|Dr|Mx)\.?\s+/i, '');
      const first = bare.split(/\s+/)[0];
      const replacement = aliases.get(bare.toLowerCase()) || `[PERSON ${++person}]`;
      aliases.set(name.toLowerCase(), replacement);
      aliases.set(bare.toLowerCase(), replacement);
      if (first.length > 1 && !aliases.has(first.toLowerCase())) aliases.set(first.toLowerCase(), replacement);
    });
    clean = clean.replace(EMAIL, value => record(value, 'Email', '[EMAIL REMOVED]'));
    if (aliases.size) {
      const pattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + [...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
      clean = clean.replace(pattern, value => record(value, 'Name', aliases.get(value.toLowerCase())));
    }

    // Explicit additions cover unusual names, named houses and other identifiers.
    const extras = (options.extraIdentifiers || []).map(value => value.trim()).filter(Boolean);
    extras.sort((a, b) => b.length - a.length).forEach(value => {
      clean = clean.replace(new RegExp(escapeRegExp(value), 'giu'), found => record(found, 'Extra detail', '[DETAIL REMOVED]'));
    });
    // Numbered streets, with optional flat/unit prefixes, and UK postal blocks.
    const street = /\b(?:(?:Flat|Apartment|Apt|Unit|Suite)\s+[\w-]+[, \t]+)?\d+[A-Z]?(?:[-/]\d+[A-Z]?)?[ \t]+(?:[\p{L}\p{M}'’.-]+[ \t]+){1,6}(?:Road|Street|Avenue|Lane|Close|Drive|Crescent|Way|Gardens|Terrace|Place|Court|Square|Grove|Mews|Rise|Walk|Row|Park|Hill|Rd|St|Ave|Ln|Dr)\b/giu;
    const streets = [...clean.matchAll(street)].reverse();
    streets.forEach(match => {
      let end = match.index + match[0].length;
      const tail = clean.slice(end, end + 160);
      const postalTail = tail.match(/^[, \t]*(?:\n?[ \t>]*[\p{L}\p{M} ,'-]+[, \t]*){0,3}\n?[ \t>]*(?:GIR\s?0AA|[A-Z]{1,2}\d[\dA-Z]?\s?\d[A-Z]{2})\b/iu);
      if (postalTail) end += postalTail[0].length;
      const address = clean.slice(match.index, end);
      clean = clean.slice(0, match.index) + record(address, 'Address', '[ADDRESS REMOVED]') + clean.slice(end);
    });
    // Labelled addresses also cover named buildings without a street number.
    clean = clean.replace(/(^[ \t>]*(?:(?:home|postal|billing|customer|street|delivery)[ \t]+)?address:[ \t]*(?:\n[ \t>]*)?)([^\n]+(?:\n[ \t>]*[^\n]{1,80}){0,4})/gim, (whole, label, block) => {
      const lines = block.split('\n');
      const postcodeLine = lines.findIndex(line => new RegExp(POSTCODE.source, 'i').test(line));
      const count = postcodeLine >= 0 ? postcodeLine + 1 : 1;
      return label + record(lines.slice(0, count).join('\n'), 'Address', '[ADDRESS REMOVED]') + (lines.length > count ? '\n' + lines.slice(count).join('\n') : '');
    });
    clean = clean.replace(/(?<![\p{L}\p{N}])(?:\+\d{1,3}|0044|0)[\d ()-]{7,22}\d(?!\d)/gu, value => {
      let digits = value.replace(/\D/g, '');
      if (digits.startsWith('0044')) digits = digits.slice(2);
      if (digits.startsWith('440')) digits = '44' + digits.slice(3);
      const valid = value.startsWith('+') ? digits.length >= 8 && digits.length <= 15 :
        digits.startsWith('44') ? digits.length === 12 : /^0\d{9,10}$/.test(digits);
      return valid ? record(value, 'Telephone', '[PHONE REMOVED]') : value;
    });
    clean = clean.replace(POSTCODE, value => record(value, 'Postcode', '[POSTCODE REMOVED]'));
    return { clean, removed };
  }
  root.HXPrivacy = { redact };
  if (typeof module !== 'undefined') module.exports = root.HXPrivacy;
})(typeof window === 'undefined' ? globalThis : window);
