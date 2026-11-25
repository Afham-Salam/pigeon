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

const CARD_BADGE_OR_AGE_REGEX =
  /^(?:easy apply|quick apply|verified|promoted|remote|hybrid|\d+\s*[dhmw]\+?|\d+\.\d+\s*★?)$/i;

/**
 * Extracts title, company, location, and salary from a job portal alert card
 * (supporting both multi-line <a> cards and single-line title + contextSnippet).
 */
export function extractStandardAlertCardFields(params: {
  cleanAnchorText: string;
  contextSnippet: string;
  companyClassRegex: RegExp;
}): {
  title: string;
  company: string;
  location: string | null;
  salaryRaw: string | null;
} {
  const { cleanAnchorText, contextSnippet, companyClassRegex } = params;

  const lines = cleanAnchorText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title = cleanAnchorText;
  let company = 'Unknown';
  let location: string | null = null;
  let salaryRaw: string | null = null;

  if (lines.length >= 2 && lines[0] && lines[1]) {
    title = lines[0];
    if (isPlausibleCompanyCandidate(lines[1], title)) {
      company = lines[1].replace(/\s+\d+(?:\.\d+)?\s*★$/, '').trim();
    }
    for (const extra of lines.slice(2)) {
      if (CARD_BADGE_OR_AGE_REGEX.test(extra)) continue;
      if (!salaryRaw && /[₹$€£]|\b(?:LPA|Lacs|Lakhs?)\b/i.test(extra) && /\d/.test(extra)) {
        salaryRaw = extra;
      } else if (!location) {
        location = extra;
      }
    }
  }

  if (company === 'Unknown') {
    const extractedCompany = extractCompanyFromCardSnippet(
      contextSnippet,
      title,
      companyClassRegex,
    );
    if (extractedCompany) {
      company = extractedCompany;
    }
  }

  if (!location) {
    const locationMatch =
      contextSnippet.match(
        /(?:class="[^"]*(?:location|loc|city|job-location)[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|p)>/i,
      ) ||
      contextSnippet.match(
        /(?:Bengaluru|Bangalore|Mumbai|Delhi|NCR|Hyderabad|Pune|Chennai|Noida|Gurgaon|Gurugram|Kolkata|Ahmedabad|Remote|Hybrid|[A-Z][a-zA-Z\s.-]+,\s*[A-Z]{2}(?:\s+\(Hybrid\)|\s+\(Remote\))?)/i,
      );

    if (locationMatch) {
      const rawLoc = locationMatch[1] ?? locationMatch[0];
      const cleanLoc = stripHtml(rawLoc).trim();
      if (cleanLoc && cleanLoc !== title && cleanLoc !== company) {
        location = cleanLoc;
      }
    }
  }

  if (!salaryRaw) {
    const salaryMatch =
      contextSnippet.match(
        /(?:class="[^"]*(?:salary|ctc|compensation|salary-info)[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|p)>/i,
      ) ||
      contextSnippet.match(
        /([₹$€£]?\s*[\d,]+(?:\.\d+)?(?:\s*k)?\s*(?:[-–to/]\s*[₹$€£]?\s*[\d,]+(?:\.\d+)?(?:\s*k)?)?\s*(?:LPA|Lacs?|Lakhs?|Cr|\/\s*(?:yr|year|mo|month|annum)|\bper\s+(?:year|annum|month)\b|\ba\s+year\b))/i,
      );

    if (salaryMatch) {
      const rawSal = salaryMatch[1] ?? salaryMatch[0];
      const candidate = stripHtml(rawSal).trim();
      if (candidate && /\d/.test(candidate)) {
        salaryRaw = candidate;
      }
    }
  }

  return { title, company, location, salaryRaw };
}
