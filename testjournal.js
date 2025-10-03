import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_JOURNAL_PATH = join(process.cwd(), 'test_journal.txt');

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function oneLine(text) {
  if (text == null) return '';
  // remove newlines; collapse whitespace; trim ends
  return String(text).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export class ContractCallLogger {
  /**
   * @param {string} [filePath] Optional path to journal (defaults to project root ./test_journal.txt)
   */
  constructor(filePath = DEFAULT_JOURNAL_PATH) {
    this.filePath = filePath;
  }

  /**
   * Append an OK line.
   * @param {string} text
   */
  async logContractCallOk(text) {
    const line = `${ts()}>OK ${oneLine(text)}\n`;
    await appendFile(this.filePath, line, 'utf8');
  }

  /**
   * Append an ERROR line.
   * @param {string} text
   */
  async logContractCallErr(text) {
    const line = `${ts()}>ERROR ${oneLine(text)}\n`;
    await appendFile(this.filePath, line, 'utf8');
  }
}