import { stripHtml } from '../../sources/html-utils.js';

const NON_COMPANY_TEXT_REGEX =
  /^(?:easy apply|just posted|today|new|urgent|promoted|actively recruiting|remote|hybrid|on-site|onsite|full-time|part-time|contract|best place to work|best-led company|\d+\s*[dhmw]\+?|\d+\.\d+\s*★?)$/i;

/**
 * Checks whether a candidate string extracted from an email card snippet looks
 * like a real company name rather than a badge, rating, salary, or age tag.
 */
export function isPlausibleCompanyCandidate(candidate: string, title: string): boolean {
  const clean = candidate.trim();
  if (!clean || clean === title || clean.length >= 100) return false;
  if (NON_COMPANY_TEXT_REGEX.test(clean)) return false;
  if (/^[₹$€£]\s*\d/.test(clean)) return false;
  return true;
}

/**
 * Extracts a company name from a card HTML snippet appearing after a job link.
 * Falls back to the first plausible plain-text tag if no company class attribute exists.
 */
export function extractCompanyFromCardSnippet(
  snippet: string,
  title: string,
  classRegex: RegExp,
): string | null {
  const classMatch = snippet.match(classRegex);
  if (classMatch?.[1]) {
    const candidate = stripHtml(classMatch[1]).trim();
    if (candidate && candidate !== title && candidate.length < 100) {
      return candidate;
    }
  }

  const tagRegex = /<(?:span|div|p|td)[^>]*>([^<]+)<\/(?:span|div|p|td)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(snippet)) !== null) {
    const candidate = stripHtml(tagMatch[1] ?? '').trim();
    if (isPlausibleCompanyCandidate(candidate, title)) {
      return candidate;
    }
  }

  return null;
}
