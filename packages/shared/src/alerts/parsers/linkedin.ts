import type { PortalParser, ParsedAlertJob } from '../types.js';
import { cleanTrackingUrl } from '../tracking-cleaner.js';
import { stripHtml } from '../../sources/html-utils.js';
import { extractCompanyFromCardSnippet } from './shared.js';

const LINKEDIN_BADGE_REGEX = /^(?:easy apply|promoted|actively recruiting)$/i;

export const linkedInParser: PortalParser = {
  portal: 'linkedin',

  matchesSender(fromAddress: string): boolean {
    const addr = fromAddress.toLowerCase().trim();
    return addr.includes('linkedin.com') || addr.includes('@linkedin.');
  },

  parse(html: string): ParsedAlertJob[] {
    const jobs: ParsedAlertJob[] = [];
    if (!html) return jobs;

    // LinkedIn job alert links typically match /jobs/view/ or /comm/jobs/view/
    // We match table rows, divs, or table cards containing a LinkedIn job link
    const linkRegex =
      /<a\b[^>]*href="([^"]*(?:linkedin\.com\/(?:comm\/)?jobs\/view\/|\/jobs\/view\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

    // Find all job links
    let match: RegExpExecArray | null;
    const seenUrls = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const rawHref = match[1] ?? '';
      const rawTitle = match[2] ?? '';
      const cleanAnchorText = stripHtml(rawTitle);

      // Skip non-job anchors like "View job", "Apply now", "See more", or empty titles
      if (
        !cleanAnchorText ||
        /^(view|see|apply|read|click|more|follow|check|unsubscribe|settings)/i.test(cleanAnchorText)
      ) {
        continue;
      }

      const applyUrl = cleanTrackingUrl(rawHref, 'linkedin');
      if (seenUrls.has(applyUrl)) {
        continue;
      }
      seenUrls.add(applyUrl);

      const lines = cleanAnchorText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      let cleanTitle = cleanAnchorText;
      let company = 'Unknown';
      let location: string | null = null;
      let salaryRaw: string | null = null;

      if (lines.length >= 2 && lines[0] && lines[1]) {
        // Newer LinkedIn alert emails wrap [Title, "Company · Location", Salary/Badge] inside <a>
        cleanTitle = lines[0];
        const parts = lines[1]
          .split(/\s*[·•]\s*/)
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts[0] && parts[0].length < 100) {
          company = parts[0];
        }
        if (parts[1]) {
          location = parts.slice(1).join(' · ');
        }
        for (const extra of lines.slice(2)) {
          if (LINKEDIN_BADGE_REGEX.test(extra)) continue;
          if (!salaryRaw && /[₹$€£]/.test(extra) && /\d/.test(extra)) {
            salaryRaw = extra;
          }
        }
      }

      // Extract the surrounding context (up to 800 characters around or after the link)
      const afterLink = html.slice(match.index + match[0].length, match.index + 800);
      const nextCardBoundary = afterLink.search(
        /<table class="job-card"|<table|<tr|<a\b[^>]*href="[^"]*linkedin\.com/i,
      );
      const contextSnippet =
        nextCardBoundary !== -1 ? afterLink.slice(0, nextCardBoundary) : afterLink;

      // Extract company from surrounding snippet when not already extracted from card anchor
      if (company === 'Unknown') {
        const extractedCompany = extractCompanyFromCardSnippet(
          contextSnippet,
          cleanTitle,
          /(?:class="[^"]*(?:company|jobsearch-Company|org)[^"]*"[^>]*>|<strong[^>]*>|<span[^>]*class="[^"]*sub-title[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|strong|p)>/i,
        );
        if (extractedCompany) {
          const parts = extractedCompany
            .split(/\s*[·•]\s*/)
            .map((p) => p.trim())
            .filter(Boolean);
          company = parts[0] || extractedCompany;
          if (!location && parts[1]) {
            location = parts.slice(1).join(' · ');
          }
        }
      }

      // Extract location
      if (!location) {
        const locationMatch =
          contextSnippet.match(
            /(?:class="[^"]*(?:location|city|job-location)[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|p)>/i,
          ) ||
          contextSnippet.match(
            /(?:[A-Z][a-zA-Z\s.-]+,\s*[A-Z]{2}(?:\s+\(Hybrid\)|\s+\(Remote\))?|\bRemote\b|\bHybrid\b)/,
          );

        if (locationMatch) {
          const rawLoc = locationMatch[1] ?? locationMatch[0];
          const cleanLoc = stripHtml(rawLoc).trim();
          if (cleanLoc && cleanLoc !== cleanTitle && cleanLoc !== company) {
            location = cleanLoc;
          }
        }
      }

      // Extract salary if mentioned (e.g. $140,000 - $180,000 / yr)
      if (!salaryRaw) {
        const salaryMatch = contextSnippet.match(
          /([$€£₹]\s*[\d,]+(?:\.\d+)?(?:\s*k)?(?:\s*[-–to/]\s*[$€£₹]?\s*[\d,]+(?:\.\d+)?(?:\s*k)?)?\s*(?:\/\s*(?:yr|year|mo|month|hr|hour)|\bper\s+(?:year|annum|month|hour)\b|\bannually\b|\ba\s+year\b))/i,
        );
        if (salaryMatch?.[1]) {
          salaryRaw = stripHtml(salaryMatch[1]).trim();
        }
      }

      jobs.push({
        title: cleanTitle,
        company,
        location,
        apply_url: applyUrl,
        salary_raw: salaryRaw,
        description: `${cleanTitle} at ${company}${location ? ` - ${location}` : ''}`,
      });
    }

    return jobs;
  },
};
