import type { PortalParser, ParsedAlertJob } from '../types.js';
import { cleanTrackingUrl } from '../tracking-cleaner.js';
import { stripHtml } from '../../sources/html-utils.js';

const IS_BOILERPLATE_OR_ACTION_REGEX =
  /^(?:view|see|apply|read|click|more|unsubscribe|settings|manage|bebee|privacy|terms|show|job|عرض|التقديم|تقديم|إلغاء|تعديل|أفضل تطابق|تنبيهات|وظائف|وظيفة)/i;

const NON_JOB_LINK_REGEX =
  /(?:unsubscribe|preferences|settings|privacy|terms|login|facebook|twitter|linkedin|instagram|app\.adjust\.com|apple\.com|google\.com\/store)/i;

export const bebeeParser: PortalParser = {
  portal: 'bebee',

  matchesSender(fromAddress: string): boolean {
    const addr = fromAddress.toLowerCase().trim();
    return addr.includes('bebee.com') || addr.includes('@bebee.');
  },

  parse(html: string): ParsedAlertJob[] {
    const jobs: ParsedAlertJob[] = [];
    if (!html) return jobs;

    // Match links pointing to any bebee domain (e.g. notification.bebee.com, ae.bebee.com, bebee.com)
    const linkRegex =
      /<a\b[^>]*href="([^"]*(?:bebee\.com|bebee\.[a-z.]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    const seenUrls = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const rawHref = match[1] ?? '';
      const rawLinkContent = match[2] ?? '';

      // Skip non-job links (unsubscribe, preferences, privacy, social media, app store)
      if (NON_JOB_LINK_REGEX.test(rawHref)) {
        continue;
      }

      const cleanText = stripHtml(rawLinkContent).trim();
      const isActionOrBoilerplate = !cleanText || IS_BOILERPLATE_OR_ACTION_REGEX.test(cleanText);

      // Card context: Look before the link (up to 1200 chars) and after the link (up to 800 chars)
      const beforeLink = html.slice(Math.max(0, match.index - 1200), match.index);
      const afterLink = html.slice(match.index + match[0].length, match.index + 800);

      let title = '';
      let company = 'Unknown';
      let location: string | null = null;
      let salaryRaw: string | null = null;

      if (!isActionOrBoilerplate && cleanText.length > 3 && cleanText.length < 150) {
        // The link text itself is the job title
        title = cleanText;
      } else {
        // The link is an action button (e.g., "عرض الوظيفة" / "View Job") or image
        // Search for title heading in the preceding card snippet
        const titleMatch =
          beforeLink.match(
            /<(?:h[1-4]|div|p|strong|span|b)[^>]*class="[^"]*(?:title|job-title|heading|position|jobname)[^"]*"[^>]*>([\s\S]*?)<\/(?:h[1-4]|div|p|strong|span|b)>/i,
          ) ||
          beforeLink.match(/<(?:h[1-4]|strong)[^>]*>([\s\S]*?)<\/(?:h[1-4]|strong)>/i) ||
          beforeLink.match(
            /(?:<b[^>]*>|<span[^>]*style="[^"]*font-weight:\s*(?:bold|[6-9]00)[^"]*"[^>]*>)([\s\S]*?)<\/(?:b|span)>/i,
          );

        if (titleMatch?.[1]) {
          const candidateTitle = stripHtml(titleMatch[1]).trim();
          if (
            candidateTitle &&
            candidateTitle.length > 3 &&
            candidateTitle.length < 150 &&
            !IS_BOILERPLATE_OR_ACTION_REGEX.test(candidateTitle)
          ) {
            title = candidateTitle;
          }
        }
      }

      // If no valid title could be extracted, skip this link
      if (!title) {
        continue;
      }

      const applyUrl = cleanTrackingUrl(rawHref, 'bebee');
      if (seenUrls.has(applyUrl)) {
        continue;
      }
      seenUrls.add(applyUrl);

      // Search for company, location, and salary in the card context.
      // If the link text was the title, details appear in afterLink.
      // If the link was an action button, details appear in beforeLink.
      const snippet = title === cleanText ? afterLink : beforeLink;

      const companyMatch =
        snippet.match(
          /(?:class="[^"]*(?:company|company-name|employer|comp-name)[^"]*"[^>]*>|<strong[^>]*>|<span[^>]*class="[^"]*company[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|strong|p|a|td)>/i,
        ) ||
        snippet.match(/<\/a>[\s\S]*?<(?:span|div|p|td)[^>]*>([\s\S]*?)<\/(?:span|div|p|td)>/i) ||
        snippet.match(
          /([A-Z][a-zA-Z0-9&.,\s'-]{2,50})\s*(?:\||\s–\s|\s-\s)\s*(?:Managed Services|Recruitment|Staffing|Consulting|Technologies|Pvt|Ltd|Inc|LLC|Solutions)/i,
        );

      if (companyMatch) {
        const rawComp = companyMatch[1] ?? companyMatch[0];
        const cleanComp = stripHtml(rawComp).trim();
        if (cleanComp && cleanComp !== title && cleanComp.length < 100) {
          company = cleanComp;
        }
      }

      // Search for location
      const locationMatch =
        snippet.match(
          /(?:class="[^"]*(?:location|city|job-location)[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|p|td)>/i,
        ) ||
        snippet.match(
          /(?:Abu Dhabi|Dubai|Sharjah|Riyadh|Doha|Bengaluru|Bangalore|Delhi|Mumbai|London|New York|\bRemote\b|\bHybrid\b|[A-Z][a-zA-Z\s.-]+,\s*[A-Z]{2}(?:\s+\(Hybrid\)|\s+\(Remote\))?)/i,
        );

      if (locationMatch) {
        const rawLoc = locationMatch[1] ?? locationMatch[0];
        const cleanLoc = stripHtml(rawLoc).trim();
        if (cleanLoc && cleanLoc !== title && cleanLoc !== company) {
          location = cleanLoc;
        }
      }

      // Search for salary
      const salaryMatch =
        snippet.match(
          /(?:class="[^"]*(?:salary|salary-info)[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|span|p)>/i,
        ) ||
        snippet.match(
          /([£$€₹AED\s]*[\d,]+(?:\.\d+)?(?:\s*k)?\s*(?:[-–to/]\s*[£$€₹AED\s]*[\d,]+(?:\.\d+)?(?:\s*k)?)?\s*(?:AED|LPA|Lacs|Lakhs?|\/\s*(?:yr|year|month|annum|hr|hour)|\bper\s+(?:year|month|annum|hour)\b|\ba\s+year\b))/i,
        );

      if (salaryMatch) {
        const rawSal = salaryMatch[1] ?? salaryMatch[0];
        const candidate = stripHtml(rawSal).trim();
        if (candidate && /[\d]/.test(candidate)) {
          salaryRaw = candidate;
        }
      }

      jobs.push({
        title,
        company,
        location,
        apply_url: applyUrl,
        salary_raw: salaryRaw,
        description: null,
      });
    }

    return jobs;
  },
};
