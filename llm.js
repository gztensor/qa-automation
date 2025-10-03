import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    // In Node, don't keep the event loop alive just because of this timer:
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return {
    promise: Promise.race([promise, timeoutP]),
    cancel: () => clearTimeout(timer),
  };
}

export async function llmRequest(prompt, opts = {}) {
  console.log(`Prompt: ${prompt}`);

  const {
    model = 'gpt-4o-mini',
    temperature = 1.5,
    timeoutMs = 10_000,
  } = opts;

  if (!client.apiKey) throw new Error('OPENAI_KEY is not set. Add it to your .env file.');

  const apiCall = client.chat.completions.create({
    model,
    temperature,
    messages: [{ role: 'user', content: prompt }],
  });

  const { promise: raced, cancel } = withTimeout(apiCall, timeoutMs, 'LLM request');

  try {
    const res = await raced;
    cancel();
    const text = res?.choices?.[0]?.message?.content ?? '';
    console.log(`LLM response: ${text}`);
    return text.trim();
  } catch (err) {
    cancel(); // also clear on error
    const msg = err?.message || String(err);
    throw new Error(`LLM request failed: ${msg}`);
  }
}

export function unwrapJson(raw) {
  if (typeof raw !== 'string') {
    throw new Error('unwrapJson: input must be a string');
  }

  // Normalize and trim weird whitespace
  let s = raw
    .replace(/\uFEFF/g, '')        // BOM
    .replace(/[\u200B-\u200D\u2060]/g, '') // zero-width chars
    .trim();

  if (!s) throw new Error('unwrapJson: empty string');

  // 1) Strip Markdown code fences ```json ... ``` / ``` ... ```
  //    (supports tagged and untagged; triple backticks or tildes)
  const fenceRegex = /^\s*(```+|~~~+)\s*(json|javascript|js|ts|text)?\s*\n([\s\S]*?)\n\1\s*$/i;
  const fenceMatch = s.match(fenceRegex);
  if (fenceMatch && fenceMatch[3]) {
    s = fenceMatch[3].trim();
  }

  // 2) If the whole thing is wrapped in a single pair of quotes/backticks, unwrap once
  const quotePairs = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['"""', '"""'],
    ["'''", "'''"],
  ];
  for (const [qL, qR] of quotePairs) {
    if (s.startsWith(qL) && s.endsWith(qR) && s.length >= qL.length + qR.length + 2) {
      s = s.slice(qL.length, -qR.length).trim();
      break; // unwrap once is enough
    }
  }

  // 3) If the string already starts with { or [, assume it *is* just JSON
  if (/^\s*[\{\[]/.test(s)) {
    return s;
  }

  // 4) Otherwise, extract the first balanced {...} or [...] block
  //    (simple heuristic: find first { or [, then scan to matching close)
  const firstBrace = s.search(/[\{\[]/);
  if (firstBrace === -1) {
    throw new Error('unwrapJson: no JSON object/array found');
  }

  // Minimal stack-based matcher to find the matching closing bracket/brace
  const openChar = s[firstBrace];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;

  for (let i = firstBrace; i < s.length; i++) {
    const ch = s[i];

    // Skip over strings to avoid counting braces inside them
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      for (; i < s.length; i++) {
        const qch = s[i];
        if (qch === '\\') { i++; continue; } // skip escaped
        if (qch === quote) break;
      }
      continue;
    }

    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;

    if (depth === 0) { end = i; break; }
  }

  if (end === -1) {
    throw new Error('unwrapJson: failed to find matching closing bracket/brace');
  }

  return s.slice(firstBrace, end + 1).trim();
}

/**
 * Remove matching quotes from both ends of a string, repeatedly.
 * Handles: ' " ` “” ‘’ «» ‹› 「」 『』 „“ ''' """ ``` (and more)
 * - Only removes when the *pair* matches (start & end).
 * - Trims outer whitespace each round, preserves inner content.
 *
 * @param {any} value
 * @returns {string}
 */
export function unwrapValue(value) {
  if (value == null) return '';
  let s = String(value).trim();
  if (s.length < 2) return s;

  // Ordered from longer to shorter so triple-quotes/backticks win first.
  const PAIRS = [
    ['"""','"""'], ["'''","'''"], ['```','```'],
    ['“','”'], ['‘','’'], ['«','»'], ['‹','›'],
    ['「','」'], ['『','』'], ['„','“'],
    ['"','"'], ["'","'"], ['`','`'],
  ];

  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    // Trim once per round to ignore outer whitespace around quotes
    s = s.trim();

    for (const [L, R] of PAIRS) {
      if (s.startsWith(L) && s.endsWith(R) && s.length >= L.length + R.length) {
        s = s.slice(L.length, s.length - R.length);
        changed = true;
        break; // restart with the inner text
      }
    }
  }

  return s;
}

export async function getContractParameterLlm(
  callDescription, 
  actorContext,
  prmDesc,
  chosenParameters,
) {
  const chosenClause = Object.keys(chosenParameters).length === 0 ?
    "" :
    `So far some parameters have been selected:\n ${JSON.stringify(chosenParameters)}`;

  const basicContextClause = actorContext.length === 0 ?
    "" :
    `
    Context specific to your account and the system in general:
    ${JSON.stringify(actorContext)}
    `    

  const prompt = `
    You are the manual QA engineer testing an API. You need to test one API 
    call with the following description: ${callDescription}. You can make one call
    and need to select the best parameters for it based on the following context.

    ${basicContextClause}

    ${chosenClause}

    Now you need to select the next parameter called ${prmDesc.name}. ${prmDesc.guidance} 
    Possible values are: ${prmDesc.values}. Randomize your choice as much as possible.
    If selecting from the list, choose strinctly one value.

    Only return a single ${prmDesc.type}.
  `;
  const raw = await llmRequest(prompt);
  return unwrapValue(raw)
}