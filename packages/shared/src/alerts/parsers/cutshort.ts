import type { PortalParser, ParsedAlertJob } from '../types.js';
import { cleanTrackingUrl } from '../tracking-cleaner.js';
import { stripHtml } from '../../sources/html-utils.js';
import { extractStandardAlertCardFields } from './shared.js';

const CUTSHORT_BOILERPLATE_REGEX =
  /^(?:view|see|apply|read|click|more|unsubscribe|settings|manage|cutshort|login|sign\s*in|privacy|terms|explore|browse)\b/i;

export const cutshortParser: PortalParser = {
  portal: 'cutshort',

  matchesSender(fromAddress: string): boolean {
    const addr = fromAddress.toLowerCase().trim();
    return addr.includes('cutshort.io') || addr.includes('@cutshort.');
  },

  parse(html: string): ParsedAlertJob[] {
    const jobs: ParsedAlertJob[] = [];
    if (!html) return jobs;

    const linkRegex =
      /<a\b[^>]*href="([^"]*(?:cutshort\.io\/(?:job|jobs)\/|\/job\/[^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    const seenUrls = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const rawHref = match[1] ?? '';
      const rawTitle = match[2] ?? '';
      const cleanAnchorText = stripHtml(rawTitle);

      if (
        !cleanAnchorText ||
        cleanAnchorText.length < 3 ||
        CUTSHORT_BOILERPLATE_REGEX.test(cleanAnchorText)
      ) {
        continue;
      }

      const applyUrl = cleanTrackingUrl(rawHref, 'cutshort');
      if (seenUrls.has(applyUrl)) {
        continue;
      }
      seenUrls.add(applyUrl);

      const afterLink = html.slice(match.index + match[0].length, match.index + 800);
      const nextCardBoundary = afterLink.search(
        /<div class="job|<table|<tr|<a\b[^>]*href="[^"]*cutshort\.io/i,
      );
      const contextSnippet =
        nextCardBoundary !== -1 ? afterLink.slice(0, nextCardBoundary) : afterLink;

      const { title, company, location, salaryRaw } = extractStandardAlertCardFields({
        cleanAnchorText,
        contextSnippet,
        companyClassRegex:
          /(?:class="[^"]*(?:company|company-name|employer|startup-name)[^"]*"[^>]*>|<strong[^>]*>|<span[^>]*class="[^"]*company[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|strong|p|a)>/i,
      });

      jobs.push({
        title,
        company,
        location,
        apply_url: applyUrl,
        salary_raw: salaryRaw,
        description: `${title} at ${company}${location ? ` - ${location}` : ''}`,
      });
    }

    return jobs;
  },
};
