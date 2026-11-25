import { describe, it, expect, vi } from 'vitest';
import PostalMime from 'postal-mime';
// @ts-expect-error Node.js fs module is available in Vitest node test runner
import * as fs from 'node:fs';
// @ts-expect-error Node.js path module is available in Vitest node test runner
import * as path from 'node:path';
import {
  cleanTrackingUrl,
  detectPortal,
  getParser,
  isAllowedSender,
  isAuthorizedForwarding,
  handleParserHealth,
  ingestAlertEmail,
  pollGmailAlerts,
  type Notifier,
} from '../index.js';
import type { D1LikeDatabase } from '../state-machine.js';
import { routeJob } from '../scoring/router.js';
import { discoverContact } from '../scoring/contact-finder.js';
import {
  LINKEDIN_EML_FIXTURE,
  NAUKRI_EML_FIXTURE,
  INDEED_EML_FIXTURE,
  UNAUTHORIZED_SENDER_EML_FIXTURE,
  WELLFOUND_EML_FIXTURE,
  OTTA_EML_FIXTURE,
  ZIPRECRUITER_EML_FIXTURE,
  DICE_EML_FIXTURE,
  GLASSDOOR_EML_FIXTURE,
  INSTAHYRE_EML_FIXTURE,
  FOUNDIT_EML_FIXTURE,
  WHATJOBS_EML_FIXTURE,
  BEBEE_EML_FIXTURE,
  AMBITIONBOX_EML_FIXTURE,
  CUTSHORT_EML_FIXTURE,
} from './fixtures.js';

// In-memory mock SQLite/D1 database for shared unit tests
function createMockDb(): {
  db: D1LikeDatabase;
  jobs: Map<string, Record<string, unknown>>;
  events: Array<{
    id: string;
    entity: string;
    entity_id: string;
    type: string;
    payload: string;
    created_at: string;
  }>;
  sourceState: Map<string, { parser_empty_streak: number; untrusted: number }>;
} {
  const jobs = new Map<string, Record<string, unknown>>();
  const events: Array<{
    id: string;
    entity: string;
    entity_id: string;
    type: string;
    payload: string;
    created_at: string;
  }> = [];
  const sourceState = new Map<string, { parser_empty_streak: number; untrusted: number }>();

  const db: D1LikeDatabase = {
    prepare(query: string) {
      let boundParams: unknown[] = [];
      const statement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (query.includes('FROM jobs WHERE dedupe_key = ?')) {
            const key = String(boundParams[0]);
            for (const [id, job] of jobs.entries()) {
              if (job['dedupe_key'] === key) {
                return { id } as unknown as T;
              }
            }
            return null;
          }
          if (query.includes('FROM source_state WHERE source = ?')) {
            const src = String(boundParams[0]);
            const state = sourceState.get(src);
            if (!state) return null;
            return {
              parser_empty_streak: state.parser_empty_streak,
              untrusted: state.untrusted,
            } as unknown as T;
          }
          if (query.includes('FROM events WHERE entity = ? AND entity_id = ?')) {
            const entity = String(boundParams[0]);
            const entityId = String(boundParams[1]);
            const ev = events.find((e) => e.entity === entity && e.entity_id === entityId);
            if (!ev) return null;
            return { entity_id: ev.entity_id } as unknown as T;
          }
          return null;
        },
        async run() {
          const trimmed = query.trim();
          if (trimmed.startsWith('INSERT INTO events')) {
            const [id, entity, entity_id, type, payload, created_at] = boundParams as string[];
            events.push({
              id: id ?? '',
              entity: entity ?? '',
              entity_id: entity_id ?? '',
              type: type ?? '',
              payload: payload ?? '',
              created_at: created_at ?? '',
            });
          } else if (trimmed.startsWith('INSERT INTO source_state')) {
            const src = String(boundParams[0]);
            let streak = 0;
            let untrusted = 0;
            if (boundParams.length >= 3 && typeof boundParams[1] === 'number') {
              streak = Number(boundParams[1]);
              untrusted = Number(boundParams[2]);
            }
            sourceState.set(src, { parser_empty_streak: streak, untrusted });
          } else if (query.startsWith('INSERT INTO jobs')) {
            const [
              id,
              dedupe_key,
              source,
              source_kind,
              source_job_id,
              title,
              company,
              company_normalized,
              location,
              remote,
              salary_min,
              salary_max,
              currency,
              salary_raw,
              description,
              apply_url,
              contact_email,
              contact_source,
              posted_at,
              fetched_at,
              status,
              apply_route,
              route_reason,
              untrusted,
              updated_at,
            ] = boundParams;
            jobs.set(String(id), {
              id,
              dedupe_key,
              source,
              source_kind,
              source_job_id,
              title,
              company,
              company_normalized,
              location,
              remote,
              salary_min,
              salary_max,
              currency,
              salary_raw,
              description,
              apply_url,
              contact_email,
              contact_source,
              posted_at,
              fetched_at,
              status,
              apply_route,
              route_reason,
              untrusted,
              updated_at,
            });
          }
          return { success: true };
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };

  return { db, jobs, events, sourceState };
}

describe('Pigeon Email Alert Ingestion (Shared Suite)', () => {
  describe('Tracking URL Cleanup', () => {
    it('strips tracking parameters while preserving functional parameters', () => {
      const linkedInRaw =
        'https://www.linkedin.com/jobs/view/1234567890?trk=eml-job-alert-member-detail&trackingId=xyz123&refId=abc789&midToken=token001';
      expect(cleanTrackingUrl(linkedInRaw)).toBe('https://www.linkedin.com/jobs/view/1234567890');

      const indeedRaw =
        'https://www.indeed.com/viewjob?jk=7a8b9c0d1e2f3a4b&from=ia-ja&tk=1h2j3k4l&qd=98765&utm_source=jobseeker-emails';
      expect(cleanTrackingUrl(indeedRaw)).toBe(
        'https://www.indeed.com/viewjob?jk=7a8b9c0d1e2f3a4b',
      );

      const naukriRaw =
        'https://www.naukri.com/job-listings-full-stack-12345?src=jobsearchDesk&sid=1726354&xp=1&px=1&utm_source=alert';
      expect(cleanTrackingUrl(naukriRaw)).toBe(
        'https://www.naukri.com/job-listings-full-stack-12345',
      );
    });

    it('cleanTrackingUrl uses per-portal allowlist to keep specific parameters and drop the rest', () => {
      // Indeed: keep only jk
      const indeedUrl =
        'https://www.indeed.com/viewjob?jk=7a8b9c0d1e2f3a4b&from=ia-ja&tk=1h2j3k4l&qd=98765&foo=bar&utm_source=email';
      expect(cleanTrackingUrl(indeedUrl)).toBe(
        'https://www.indeed.com/viewjob?jk=7a8b9c0d1e2f3a4b',
      );

      // LinkedIn: keep only currentJobId
      const linkedInUrl =
        'https://www.linkedin.com/jobs/view/?currentJobId=3948572019&trk=eml-job-alert&midToken=xyz&extra=dropme';
      expect(cleanTrackingUrl(linkedInUrl)).toBe(
        'https://www.linkedin.com/jobs/view/?currentJobId=3948572019',
      );

      // LinkedIn standard direct URL without currentJobId: drops all query params
      const linkedInDirect =
        'https://www.linkedin.com/jobs/view/1234567890?trk=eml&refId=abc&trackingId=def';
      expect(cleanTrackingUrl(linkedInDirect)).toBe(
        'https://www.linkedin.com/jobs/view/1234567890',
      );

      // Naukri: keeps no query params beyond the path
      const naukriUrl =
        'https://www.naukri.com/job-listings-full-stack-12345?src=jobsearchDesk&sid=1726354&xp=1&px=1&custom=drop';
      expect(cleanTrackingUrl(naukriUrl)).toBe(
        'https://www.naukri.com/job-listings-full-stack-12345',
      );

      // Unknown portal: only drops utm_* and preserves other query params
      const unknownUrl =
        'https://company.careers/jobs/42?utm_source=newsletter&utm_medium=email&reqId=9999&dept=engineering';
      expect(cleanTrackingUrl(unknownUrl)).toBe(
        'https://company.careers/jobs/42?reqId=9999&dept=engineering',
      );

      // WhatJobs: keeps jobid / id
      const whatjobsUrl =
        'https://www.whatjobs.com/job/senior-flutter-developer-88776655?jobid=88776655&utm_source=alert&extra=drop';
      expect(cleanTrackingUrl(whatjobsUrl)).toBe(
        'https://www.whatjobs.com/job/senior-flutter-developer-88776655?jobid=88776655',
      );

      // beBee: keeps id
      const bebeeUrl =
        'https://bebee.com/job/flutter-engineer-998877?id=998877&utm_source=alert&extra=drop';
      expect(cleanTrackingUrl(bebeeUrl)).toBe(
        'https://bebee.com/job/flutter-engineer-998877?id=998877',
      );

      // AmbitionBox: keeps jobid / id
      const ambitionBoxUrl =
        'https://www.ambitionbox.com/jobs/flutter-developer-jobs-in-bengaluru-jd-90123?jobId=90123&utm_source=email&extra=drop';
      expect(cleanTrackingUrl(ambitionBoxUrl)).toBe(
        'https://www.ambitionbox.com/jobs/flutter-developer-jobs-in-bengaluru-jd-90123?jobId=90123',
      );

      // Cutshort: keeps jobid / id
      const cutshortUrl =
        'https://cutshort.io/job/senior-flutter-engineer-cred-cs8877?id=cs8877&utm_source=digest&extra=drop';
      expect(cleanTrackingUrl(cutshortUrl)).toBe(
        'https://cutshort.io/job/senior-flutter-engineer-cred-cs8877?id=cs8877',
      );
    });

    it('cleans tracking hash/fragment', () => {
      const url = 'https://example.com/jobs/42?foo=bar#utm_source=newsletter';
      expect(cleanTrackingUrl(url)).toBe('https://example.com/jobs/42?foo=bar');
    });

    it('handles empty or malformed strings safely without throwing', () => {
      expect(cleanTrackingUrl('')).toBe('');
      expect(cleanTrackingUrl('not-a-valid-url')).toBe('not-a-valid-url');
    });
  });

  describe('Sender & Forwarding Validation', () => {
    it('allows valid sender domains and subdomains', () => {
      expect(isAllowedSender('jobalerts-noreply@linkedin.com')).toBe(true);
      expect(isAllowedSender('notifications@em.linkedin.com')).toBe(true);
      expect(isAllowedSender('jobalerts@naukri.com')).toBe(true);
      expect(isAllowedSender('alert@indeed.com')).toBe(true);
      expect(isAllowedSender('jobs@mail.indeed.com')).toBe(true);
      expect(isAllowedSender('alerts@whatjobs.com')).toBe(true);
      expect(isAllowedSender('notifications@in.whatjobs.com')).toBe(true);
      expect(isAllowedSender('jobs@bebee.com')).toBe(true);
      expect(isAllowedSender('alerts@us.bebee.com')).toBe(true);
      expect(isAllowedSender('jobalerts@ambitionbox.com')).toBe(true);
      expect(isAllowedSender('alerts@cutshort.io')).toBe(true);
    });

    it('rejects unknown sender domains', () => {
      expect(isAllowedSender('promo@spam-job-offers.com')).toBe(false);
      expect(isAllowedSender('recruiter@randomcompany.org')).toBe(false);
      expect(isAllowedSender('phishing@fakelinkedin.net')).toBe(false);
      expect(isAllowedSender('')).toBe(false);
    });

    it('strictly requires envelope sender to match configured forwarding address (header matches alone are rejected)', () => {
      const configured = 'alex.mercer@example.com';

      // Valid: envelope sender matches configured address (case-insensitive)
      expect(
        isAuthorizedForwarding({
          envelopeSender: 'ALEX.MERCER@EXAMPLE.COM',
          configuredAddress: configured,
        }),
      ).toBe(true);

      // Invalid: envelope sender does not match
      expect(
        isAuthorizedForwarding({
          envelopeSender: 'stranger@other.com',
          configuredAddress: configured,
        }),
      ).toBe(false);

      // Invalid: missing envelope sender
      expect(
        isAuthorizedForwarding({
          envelopeSender: undefined,
          configuredAddress: configured,
        }),
      ).toBe(false);
    });
  });

  describe('Portal Parsers with .eml Fixtures', () => {
    it('LinkedIn parser extracts exact job list and cleans HTML from titles', async () => {
      const email = await new PostalMime().parse(LINKEDIN_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('linkedin');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);

      // Job 1: verify HTML entities decoded in title and tracking stripped from apply_url
      expect(jobs[0]?.title).toBe('Senior Systems Engineer & Architect');
      expect(jobs[0]?.company).toBe('Acme Cloud Technologies Inc');
      expect(jobs[0]?.location).toBe('San Francisco, CA (Remote)');
      expect(jobs[0]?.salary_raw).toBe('$150,000 - $180,000 / yr');
      expect(jobs[0]?.apply_url).toBe('https://www.linkedin.com/comm/jobs/view/3948572019');

      // Job 2
      expect(jobs[1]?.title).toBe('Distributed Systems Specialist');
      expect(jobs[1]?.company).toBe('Globex Corporation');
      expect(jobs[1]?.location).toBe('New York, NY');
      expect(jobs[1]?.apply_url).toBe('https://www.linkedin.com/jobs/view/3948572020');
    });

    it('Naukri parser extracts exact job list and strips HTML tags from titles', async () => {
      const email = await new PostalMime().parse(NAUKRI_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('naukri');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);

      expect(jobs[0]?.title).toBe('Full Stack Lead Developer');
      expect(jobs[0]?.company).toBe('Initech India Pvt Ltd');
      expect(jobs[0]?.location).toBe('Bengaluru / Bangalore');
      expect(jobs[0]?.salary_raw).toBe('18-28 Lacs PA');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.naukri.com/job-listings-full-stack-lead-initech-bengaluru-9876543210',
      );

      expect(jobs[1]?.title).toBe('DevOps & Platform Engineer');
      expect(jobs[1]?.company).toBe('Hooli Operations');
      expect(jobs[1]?.location).toBe('Hyderabad');
      expect(jobs[1]?.salary_raw).toBeNull();
    });

    it('Indeed parser extracts exact job list and preserves jk parameter', async () => {
      const email = await new PostalMime().parse(INDEED_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('indeed');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);

      expect(jobs[0]?.title).toBe('Principal Software Engineer');
      expect(jobs[0]?.company).toBe('Umbrella Corporation');
      expect(jobs[0]?.location).toBe('Remote');
      expect(jobs[0]?.salary_raw).toBe('$160,000 - $200,000 a year');
      expect(jobs[0]?.apply_url).toBe('https://www.indeed.com/viewjob?jk=7a8b9c0d1e2f3a4b');

      expect(jobs[1]?.title).toBe('Site Reliability Engineer');
      expect(jobs[1]?.company).toBe('Cyberdyne Systems');
      expect(jobs[1]?.location).toBe('Austin, TX');
      expect(jobs[1]?.apply_url).toBe('https://www.indeed.com/viewjob?jk=5c6d7e8f9a0b1c2d');
    });

    it('Wellfound parser extracts startup jobs and cleans tracking parameters', async () => {
      const email = await new PostalMime().parse(WELLFOUND_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('wellfound');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Senior Backend Engineer');
      expect(jobs[0]?.company).toBe('Supabase Scale Labs');
      expect(jobs[0]?.location).toBe('San Francisco, CA (Remote)');
      expect(jobs[0]?.salary_raw).toBe('$160k – $190k • 0.2% equity');
      expect(jobs[0]?.apply_url).toBe('https://wellfound.com/jobs/3019284-senior-backend-engineer');
    });

    it('Otta parser extracts curated tech job alerts with salary and remote status', async () => {
      const email = await new PostalMime().parse(OTTA_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('otta');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Staff Infrastructure Engineer');
      expect(jobs[0]?.company).toBe('Linear Orbit Inc');
      expect(jobs[0]?.location).toBe('Remote');
      expect(jobs[0]?.salary_raw).toBe('$180,000 - $220,000 / year');
      expect(jobs[0]?.apply_url).toBe(
        'https://otta.com/jobs/staff-infrastructure-engineer-cloud-scale',
      );
    });

    it('ZipRecruiter parser extracts jobs and preserves jid parameter', async () => {
      const email = await new PostalMime().parse(ZIPRECRUITER_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('ziprecruiter');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Cloud Systems Engineer');
      expect(jobs[0]?.company).toBe('Apex Defense Tech');
      expect(jobs[0]?.location).toBe('Austin, TX');
      expect(jobs[0]?.salary_raw).toBe('$140,000 - $165,000 / year');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.ziprecruiter.com/jobs/cloud-systems-engineer-9988?jid=zr-1234',
      );
    });

    it('Dice parser extracts tech jobs and preserves jobId parameter', async () => {
      const email = await new PostalMime().parse(DICE_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('dice');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('DevOps Architect');
      expect(jobs[0]?.company).toBe('Redwood Systems');
      expect(jobs[0]?.location).toBe('Remote');
      expect(jobs[0]?.salary_raw).toBe('$150,000 - $175,000 / year');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.dice.com/job-detail/55443322-devops-architect?jobId=dice-99',
      );
    });

    it('Glassdoor parser extracts jobs and preserves jl parameter', async () => {
      const email = await new PostalMime().parse(GLASSDOOR_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('glassdoor');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Site Reliability Engineer');
      expect(jobs[0]?.company).toBe('Stripe Global');
      expect(jobs[0]?.location).toBe('Seattle, WA (Hybrid)');
      expect(jobs[0]?.salary_raw).toBe('$165,000 - $195,000 / year');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.glassdoor.com/job-listing/site-reliability-engineer-cloud-JL_1009988.htm?jl=1009988',
      );
    });

    it('Instahyre parser extracts opportunities and locations', async () => {
      const email = await new PostalMime().parse(INSTAHYRE_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('instahyre');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Backend Lead Engineer');
      expect(jobs[0]?.company).toBe('Razorpay Software');
      expect(jobs[0]?.location).toBe('Bengaluru');
      expect(jobs[0]?.salary_raw).toBe('35 - 50 LPA');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.instahyre.com/job-182940-backend-lead-at-razorpay',
      );
    });

    it('Foundit parser extracts jobs and strips tracking parameters', async () => {
      const email = await new PostalMime().parse(FOUNDIT_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('foundit');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Principal Software Engineer');
      expect(jobs[0]?.company).toBe('Infosys Digital');
      expect(jobs[0]?.location).toBe('Hyderabad');
      expect(jobs[0]?.salary_raw).toBe('30 - 45 LPA');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.foundit.in/job/principal-software-engineer-cloud-12345',
      );
    });

    it('WhatJobs parser extracts jobs and preserves jobid parameter', async () => {
      const email = await new PostalMime().parse(WHATJOBS_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('whatjobs');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.title).toBe('Senior Flutter Developer');
      expect(jobs[0]?.company).toBe('Fintech Solutions Ltd');
      expect(jobs[0]?.location).toBe('London, UK (Remote)');
      expect(jobs[0]?.salary_raw).toBe('£75,000 - £90,000 / year');
      expect(jobs[0]?.apply_url).toBe(
        'https://www.whatjobs.com/job/senior-flutter-developer-88776655?jobid=88776655',
      );

      expect(jobs[1]?.title).toBe('Mobile App Architect (Flutter / Dart)');
      expect(jobs[1]?.company).toBe('NeoTech Global');
      expect(jobs[1]?.location).toBe('Bengaluru, India');
      expect(jobs[1]?.salary_raw).toBe('₹25 - 35 LPA');
      expect(jobs[1]?.apply_url).toBe(
        'https://in.whatjobs.com/jobs/detail/mobile-app-architect-44332211?id=44332211',
      );
    });

    it('beBee parser extracts jobs and preserves id parameter', async () => {
      const email = await new PostalMime().parse(BEBEE_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('bebee');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.title).toBe('Flutter Engineer (Cross-Platform)');
      expect(jobs[0]?.company).toBe('Global Mobility Corp');
      expect(jobs[0]?.location).toBe('Dubai, UAE (Hybrid)');
      expect(jobs[0]?.salary_raw).toBe('$90,000 - $110,000 / year');
      expect(jobs[0]?.apply_url).toBe(
        'https://bebee.com/job/flutter-engineer-cross-platform-998877?id=998877',
      );

      expect(jobs[1]?.title).toBe('Lead Dart Developer');
      expect(jobs[1]?.company).toBe('Apex Apps India');
      expect(jobs[1]?.location).toBe('Bengaluru');
      expect(jobs[1]?.apply_url).toBe('https://bebee.com/in/jobs/lead-dart-developer-665544');
    });

    it('AmbitionBox parser extracts single-line and multi-line cards cleanly', async () => {
      const email = await new PostalMime().parse(AMBITIONBOX_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('ambitionbox');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
        title: 'Flutter Developer',
        company: 'Razorpay Software',
        location: 'Bengaluru',
        salary_raw: '18 - 28 LPA',
        apply_url:
          'https://www.ambitionbox.com/jobs/flutter-developer-jobs-in-bengaluru-jd-90123?jobId=90123',
        description: 'Flutter Developer at Razorpay Software - Bengaluru',
      });
      expect(jobs[1]).toMatchObject({
        title: 'Senior Mobile Engineer',
        company: 'PhonePe',
        location: 'Pune',
        salary_raw: '25 - 35 LPA',
        apply_url: 'https://www.ambitionbox.com/jobs/mobile-engineer-jobs-in-pune-90124',
      });
    });

    it('Cutshort parser extracts jobs from class-based and plain-cell cards', async () => {
      const email = await new PostalMime().parse(CUTSHORT_EML_FIXTURE);
      const portal = detectPortal(email.from?.address ?? '');
      expect(portal).toBe('cutshort');

      const parser = getParser(portal);
      const jobs = parser.parse(email.html ?? '');

      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
        title: 'Senior Flutter Engineer',
        company: 'CRED',
        location: 'Bengaluru',
        salary_raw: '24 - 40 LPA',
        apply_url: 'https://cutshort.io/job/senior-flutter-engineer-cred-cs8877?id=cs8877',
        description: 'Senior Flutter Engineer at CRED - Bengaluru',
      });
      expect(jobs[1]).toMatchObject({
        title: 'Mobile App Developer (Flutter)',
        company: 'Groww',
        location: 'Remote',
        apply_url: 'https://cutshort.io/job/mobile-app-developer-groww-cs8878',
      });
    });

    it('beBee parser extracts jobs from card layouts with Arabic action buttons and notification tracking links', () => {
      const arabicBebeeHtml = `
        <div style="direction: rtl;">
          <h1>تنبيهات beBee</h1>
          <p>اليوم هناك 7 عروض جديدة تناسب بحثك.</p>
          <div class="job-card" style="border: 1px solid #ccc; padding: 15px;">
            <div class="company" style="font-size: 14px;">Halian | Managed Services, Recruitment Agency &amp; Contract Staffing</div>
            <h3 class="title" style="font-size: 18px; font-weight: bold;">FinTech Security Testing Engineer — Web, Mobile &amp; API</h3>
            <span class="location" style="color: #666;">Abu Dhabi</span>
            <div style="margin-top: 10px;">
              <a href="https://notification.bebee.com/c/12345/67890?id=12345&amp;utm_source=alert_email" style="background: orange; color: white; padding: 8px 16px;">
                عرض الوظيفة
              </a>
            </div>
          </div>
          <div class="footer">
            <a href="https://notification.bebee.com/unsubscribe?uid=999">إلغاء الاشتراك</a>
          </div>
        </div>
      `;

      const parser = getParser('bebee');
      const jobs = parser.parse(arabicBebeeHtml);

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('FinTech Security Testing Engineer — Web, Mobile & API');
      expect(jobs[0]?.company).toBe(
        'Halian | Managed Services, Recruitment Agency & Contract Staffing',
      );
      expect(jobs[0]?.location).toBe('Abu Dhabi');
      expect(jobs[0]?.apply_url).toBe('https://notification.bebee.com/c/12345/67890?id=12345');
    });

    it('splits multi-line card anchors cleanly for Glassdoor, LinkedIn, beBee, and plain-cell Indeed alerts', () => {
      const glassdoorHtml = `
        <a href="https://www.glassdoor.com/job-listing/create">Create</a>
        <a href="https://www.glassdoor.com/job-listing/bonc-flutter?jl=101">
          <div>BONC</div>
          <div>Flutter Developer</div>
          <div>Remote</div>
          <div>₹11K - ₹20K (Employer est.)</div>
          <div>Easy Apply</div>
          <div>4d</div>
        </a>
        <a href="https://www.glassdoor.com/job-listing/nikah-flutter?jl=102">
          <div>Nikah Forever 3.3 ★</div>
          <div>SDE 1 (Flutter)</div>
          <div>Delhi</div>
          <div>5d</div>
        </a>
      `;
      const gdJobs = getParser('glassdoor').parse(glassdoorHtml);
      expect(gdJobs).toHaveLength(2);
      expect(gdJobs[0]).toMatchObject({
        title: 'Flutter Developer',
        company: 'BONC',
        location: 'Remote',
        salary_raw: '₹11K - ₹20K (Employer est.)',
        description: 'Flutter Developer at BONC - Remote',
      });
      expect(gdJobs[1]).toMatchObject({
        title: 'SDE 1 (Flutter)',
        company: 'Nikah Forever',
        location: 'Delhi',
      });

      const linkedInHtml = `
        <a href="https://www.linkedin.com/jobs/view/112233">
          <div>Mobile Engineer (Flutter)</div>
          <div>Tarkio &middot; India (Remote)</div>
          <div>₹350K-₹450K / year</div>
        </a>
      `;
      const liJobs = getParser('linkedin').parse(linkedInHtml);
      expect(liJobs).toHaveLength(1);
      expect(liJobs[0]).toMatchObject({
        title: 'Mobile Engineer (Flutter)',
        company: 'Tarkio',
        location: 'India (Remote)',
        salary_raw: '₹350K-₹450K / year',
      });

      const bebeeHtml = `
        <a href="https://notification.bebee.com/c/1/2">،مرحبًا</a>
        <a href="https://notification.bebee.com/c/1/3">إدارة التنبيهات</a>
        <a href="https://notification.bebee.com/c/1/4">
          <div>C</div>
          <div>Mobile App Developer</div>
          <div>CignaAbu Dhabi</div>
        </a>
      `;
      const bbJobs = getParser('bebee').parse(bebeeHtml);
      expect(bbJobs).toHaveLength(1);
      expect(bbJobs[0]).toMatchObject({
        title: 'Mobile App Developer',
        company: 'Cigna',
        location: 'Abu Dhabi',
      });

      const indeedHtml = `
        <div>
          <a href="https://www.indeed.com/viewjob?jk=abc123">Senior Flutter Developer</a>
          <div>Easy Apply</div>
          <div>Acme Mobile Pvt Ltd</div>
          <div>Bengaluru, KA</div>
        </div>
      `;
      const inJobs = getParser('indeed').parse(indeedHtml);
      expect(inJobs).toHaveLength(1);
      expect(inJobs[0]).toMatchObject({
        title: 'Senior Flutter Developer',
        company: 'Acme Mobile Pvt Ltd',
      });
    });

    it('extracts plain-cell company names and populates non-null description across remaining portal parsers', () => {
      const portals: Array<{ portal: string; href: string }> = [
        { portal: 'naukri', href: 'https://www.naukri.com/job-listings-flutter-dev-999' },
        { portal: 'dice', href: 'https://www.dice.com/job-detail/flutter-999' },
        { portal: 'wellfound', href: 'https://wellfound.com/jobs/999-flutter' },
        { portal: 'instahyre', href: 'https://www.instahyre.com/job-999-flutter' },
        { portal: 'whatjobs', href: 'https://www.whatjobs.com/job/flutter-999' },
        { portal: 'otta', href: 'https://otta.com/jobs/flutter-999' },
        { portal: 'ziprecruiter', href: 'https://www.ziprecruiter.com/jobs/flutter-999' },
        { portal: 'foundit', href: 'https://www.foundit.in/job/flutter-999' },
      ];

      for (const { portal, href } of portals) {
        const html = `
          <div>
            <a href="${href}">Senior Flutter Engineer</a>
            <div>Easy Apply</div>
            <div>MobileCraft Labs</div>
            <div>Remote</div>
          </div>
        `;
        const parsed = getParser(portal as Parameters<typeof getParser>[0]).parse(html);
        expect(parsed, `Expected 1 job for ${portal}`).toHaveLength(1);
        expect(parsed[0]?.company, `Expected company for ${portal}`).toBe('MobileCraft Labs');
        expect(parsed[0]?.description, `Expected description for ${portal}`).toContain(
          'Senior Flutter Engineer at MobileCraft Labs',
        );
      }
    });

    it('Fallback parser extracts job links from generic HTML', () => {
      const fallbackHtml = `
        <div>
          <h2>Weekly Engineering Leads</h2>
          <a href="https://example.org/careers/lead-architect?utm_source=test">Staff Lead Architect</a>
        </div>
      `;
      const parser = getParser('fallback');
      const jobs = parser.parse(fallbackHtml);

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.title).toBe('Staff Lead Architect');
      expect(jobs[0]?.apply_url).toBe('https://example.org/careers/lead-architect');
    });
  });

  describe('Parser Health & Suspect Streak Tracking', () => {
    it('increments streak on empty digest and resets on good parse', async () => {
      const { db, events } = createMockDb();
      const mockNotifier: Notifier = { notify: vi.fn() };

      // 1st empty parse
      const res1 = await handleParserHealth({
        db,
        portal: 'linkedin',
        jobsCount: 0,
        notifier: mockNotifier,
      });
      expect(res1.streak).toBe(1);
      expect(res1.isSuspect).toBe(false);
      expect(events.filter((e) => e.type === 'parser_empty')).toHaveLength(1);

      // 2nd empty parse
      const res2 = await handleParserHealth({
        db,
        portal: 'linkedin',
        jobsCount: 0,
        notifier: mockNotifier,
      });
      expect(res2.streak).toBe(2);
      expect(res2.isSuspect).toBe(false);

      // 3rd empty parse: suspect event written, notifier called ONCE, portal marked untrusted
      const res3 = await handleParserHealth({
        db,
        portal: 'linkedin',
        jobsCount: 0,
        notifier: mockNotifier,
      });
      expect(res3.streak).toBe(3);
      expect(res3.isSuspect).toBe(true);
      expect(res3.portalUntrusted).toBe(true);

      const suspectEvents = events.filter((e) => e.type === 'parser_suspect');
      expect(suspectEvents).toHaveLength(1);
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
      expect(mockNotifier.notify).toHaveBeenCalledWith({
        key: 'parser_suspect:linkedin',
        message: 'Parser suspect for portal linkedin: 3 consecutive empty parses',
        details: { portal: 'linkedin', streak: 3 },
      });

      // 4th empty parse: streak is 4, but parser_suspect does NOT fire again and notifier is NOT called again
      const res4 = await handleParserHealth({
        db,
        portal: 'linkedin',
        jobsCount: 0,
        notifier: mockNotifier,
      });
      expect(res4.streak).toBe(4);
      expect(res4.isSuspect).toBe(true);
      expect(events.filter((e) => e.type === 'parser_suspect')).toHaveLength(1);
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1);

      // Good parse arrives: resets streak to 0 and clears portal untrusted flag
      const resGood = await handleParserHealth({
        db,
        portal: 'linkedin',
        jobsCount: 3,
        notifier: mockNotifier,
      });
      expect(resGood.streak).toBe(0);
      expect(resGood.isSuspect).toBe(false);
      expect(resGood.portalUntrusted).toBe(false);

      // Subsequent empty parse starts streak at 1 again
      const resNext = await handleParserHealth({
        db,
        portal: 'linkedin',
        jobsCount: 0,
        notifier: mockNotifier,
      });
      expect(resNext.streak).toBe(1);
    });
  });

  describe('End-to-End Ingestion Pipeline', () => {
    it('ingests jobs leaving apply_route and route_reason null (phase 4 router owns them)', async () => {
      const { db, jobs } = createMockDb();

      const result = await ingestAlertEmail(LINKEDIN_EML_FIXTURE, {
        db,
        envelope: { from: 'alex.mercer@example.com' },
        configuredForwardingAddress: 'alex.mercer@example.com',
      });

      expect(result.dropped).toBe(false);
      expect(result.jobsFound).toBe(2);
      expect(result.newJobs).toBe(2);
      expect(result.duplicates).toBe(0);

      expect(jobs.size).toBe(2);
      const jobList = Array.from(jobs.values());
      for (const j of jobList) {
        expect(j['source_kind']).toBe('alert_email');
        expect(j['contact_source']).toBe('none');
        expect(j['contact_email']).toBeNull();
        expect(j['apply_route']).toBeNull();
        expect(j['route_reason']).toBeNull();
        expect(j['untrusted']).toBe(0);
      }
    });

    it('does not collide dedupe keys for different Unknown-company postings with the same title', async () => {
      const { db, jobs } = createMockDb();
      const rawEml = `From: "Indeed Job Alert" <alert@indeed.com>
To: "Alex Mercer" <alex.mercer@example.com>
Subject: 2 new jobs for 'Flutter Developer'
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<html><body>
  <a href="https://www.indeed.com/viewjob?jk=aaa111">Flutter Developer</a>
  <a href="https://www.indeed.com/viewjob?jk=bbb222">Flutter Developer</a>
</body></html>`;

      const res1 = await ingestAlertEmail(rawEml, { db });
      expect(res1.jobsFound).toBe(2);
      expect(res1.newJobs).toBe(2);
      expect(res1.duplicates).toBe(0);
      expect(jobs.size).toBe(2);

      // Re-ingesting the same email still deduplicates both postings
      const res2 = await ingestAlertEmail(rawEml, { db });
      expect(res2.newJobs).toBe(0);
      expect(res2.duplicates).toBe(2);
    });

    it('rejects unknown sender and logs email_dropped with NO body content', async () => {
      const { db, events, jobs } = createMockDb();

      const result = await ingestAlertEmail(UNAUTHORIZED_SENDER_EML_FIXTURE, {
        db,
        envelope: { from: 'alex.mercer@example.com' },
        configuredForwardingAddress: 'alex.mercer@example.com',
      });

      expect(result.dropped).toBe(true);
      expect(result.dropReason).toBe('unauthorized_sender');
      expect(jobs.size).toBe(0);

      const dropEvents = events.filter((e) => e.type === 'email_dropped');
      expect(dropEvents).toHaveLength(1);
      const payload = JSON.parse(dropEvents[0]?.payload ?? '{}');
      expect(payload.reason).toBe('unauthorized_sender');
      expect(payload.from).toContain('spam-job-offers.com');
      // Assert NO email body content is present in payload
      expect(payload.body).toBeUndefined();
      expect(payload.html).toBeUndefined();
      expect(payload.text).toBeUndefined();
    });

    it('rejects when From says linkedin.com but envelope sender is not the configured address', async () => {
      const { db, events, jobs } = createMockDb();

      // Original From header says linkedin.com, but envelope sender is an unconfigured address
      const result = await ingestAlertEmail(LINKEDIN_EML_FIXTURE, {
        db,
        envelope: { from: 'unauthorized-forwarder@stranger.org' },
        configuredForwardingAddress: 'alex.mercer@example.com',
      });

      expect(result.dropped).toBe(true);
      expect(result.dropReason).toBe('invalid_forwarding_address');
      expect(jobs.size).toBe(0);

      const dropEvents = events.filter((e) => e.type === 'email_dropped');
      expect(dropEvents).toHaveLength(1);
      const payload = JSON.parse(dropEvents[0]?.payload ?? '{}');
      expect(payload.reason).toBe('invalid_forwarding_address');
      expect(payload.from).toBe('unauthorized-forwarder@stranger.org');
      expect(payload.body).toBeUndefined();
    });

    it('deduplicates a job already ingested from an API source', async () => {
      const { db, jobs } = createMockDb();

      // First run: 2 new jobs inserted
      const run1 = await ingestAlertEmail(LINKEDIN_EML_FIXTURE, {
        db,
        envelope: { from: 'alex.mercer@example.com' },
        configuredForwardingAddress: 'alex.mercer@example.com',
      });
      expect(run1.newJobs).toBe(2);
      expect(run1.duplicates).toBe(0);

      // Second run with the exact same alert: 0 new jobs, 2 duplicates
      const run2 = await ingestAlertEmail(LINKEDIN_EML_FIXTURE, {
        db,
        envelope: { from: 'alex.mercer@example.com' },
        configuredForwardingAddress: 'alex.mercer@example.com',
      });
      expect(run2.newJobs).toBe(0);
      expect(run2.duplicates).toBe(2);
      expect(jobs.size).toBe(2);
    });

    it('jobs ingested while portal is untrusted carry untrusted=true with no route_reason', async () => {
      const { db, jobs, sourceState } = createMockDb();
      // Pre-mark portal untrusted (streak reached 3)
      sourceState.set('indeed', { parser_empty_streak: 3, untrusted: 1 });

      const result = await ingestAlertEmail(INDEED_EML_FIXTURE, {
        db,
        envelope: { from: 'alex.mercer@example.com' },
        configuredForwardingAddress: 'alex.mercer@example.com',
      });

      expect(result.jobsFound).toBe(2);
      expect(result.newJobs).toBe(2);
      // Once parsed successfully, the portal untrusted flag is cleared
      expect(result.untrusted).toBe(false);

      const jobList = Array.from(jobs.values());
      for (const j of jobList) {
        expect(j['untrusted']).toBe(0);
        expect(j['route_reason']).toBeNull();
        expect(j['apply_route']).toBeNull();
      }
    });

    it('recovery: 3 empties mark portal untrusted; one good parse clears untrusted flag and new jobs have untrusted=false', async () => {
      const { db, jobs, sourceState } = createMockDb();
      const mockNotifier: Notifier = { notify: vi.fn() };

      // 1. Three empty parses mark the portal untrusted
      await handleParserHealth({ db, portal: 'indeed', jobsCount: 0, notifier: mockNotifier });
      await handleParserHealth({ db, portal: 'indeed', jobsCount: 0, notifier: mockNotifier });
      const empty3 = await handleParserHealth({
        db,
        portal: 'indeed',
        jobsCount: 0,
        notifier: mockNotifier,
      });
      expect(empty3.streak).toBe(3);
      expect(empty3.portalUntrusted).toBe(true);
      expect(sourceState.get('indeed')?.untrusted).toBe(1);

      // 2. One good parse clears untrusted flag and resets streak
      const goodResult = await ingestAlertEmail(INDEED_EML_FIXTURE, {
        db,
        envelope: { from: 'alex.mercer@example.com' },
        configuredForwardingAddress: 'alex.mercer@example.com',
        notifier: mockNotifier,
      });

      expect(goodResult.jobsFound).toBe(2);
      expect(goodResult.newJobs).toBe(2);
      expect(goodResult.emptyStreak).toBe(0);
      expect(goodResult.untrusted).toBe(false);

      // Verify portal state in source_state is cleared
      const portalState = sourceState.get('indeed');
      expect(portalState?.parser_empty_streak).toBe(0);
      expect(portalState?.untrusted).toBe(0);

      // Verify newly ingested jobs have untrusted=0
      const jobList = Array.from(jobs.values());
      for (const j of jobList) {
        expect(j['untrusted']).toBe(0);
        expect(j['apply_route']).toBeNull();
        expect(j['route_reason']).toBeNull();
      }
    });
  });

  describe('Realistic Alert Fixtures & Routing Suite', () => {
    const proc = (globalThis as unknown as { process?: { cwd?: () => string } }).process;
    let rootDir = proc?.cwd ? proc.cwd() : '.';
    while (
      !fs.existsSync(path.join(rootDir, 'pnpm-workspace.yaml')) &&
      path.dirname(rootDir) !== rootDir
    ) {
      rootDir = path.dirname(rootDir);
    }
    const fixturesDir = path.join(rootDir, 'packages/shared/fixtures/alerts');

    it('a. LinkedIn-style alert parses 2 job links and routes to manual_portal, not auto_email', async () => {
      const emlPath = path.join(fixturesDir, 'linkedin-alert.eml');
      expect(fs.existsSync(emlPath)).toBe(true);
      const rawEml = fs.readFileSync(emlPath, 'utf8');

      const { db, jobs } = createMockDb();
      const result = await ingestAlertEmail(rawEml, {
        db,
        envelope: { from: 'alex.mercer@example.test' },
        configuredForwardingAddress: 'alex.mercer@example.test',
      });

      expect(result.dropped).toBeFalsy();
      expect(result.jobsFound).toBe(2);
      expect(result.newJobs).toBe(2);

      const jobList = Array.from(jobs.values());
      expect(jobList.length).toBe(2);

      for (const j of jobList) {
        expect(j['source']).toBe('linkedin');
        expect(j['source_kind']).toBe('alert_email');

        // Route evaluation
        const decision = routeJob({
          source_kind: 'alert_email',
          company: String(j['company']),
          contact_source: 'none',
          contact_email: null,
        });

        // Asserts portal route, NOT auto_email
        expect(decision.route).toBe('manual_portal');
        expect(decision.reason).toBe('PORTAL_NO_EMAIL');
        expect(decision.route).not.toBe('auto_email');
      }
    });

    it('b. Generic digest alert with recruiter contact in body routes based on contact finder', async () => {
      const emlPath = path.join(fixturesDir, 'digest-alert.eml');
      expect(fs.existsSync(emlPath)).toBe(true);
      const rawEml = fs.readFileSync(emlPath, 'utf8');

      const { db, jobs } = createMockDb();
      const result = await ingestAlertEmail(rawEml, {
        db,
        envelope: { from: 'alex.mercer@example.test' },
        configuredForwardingAddress: 'alex.mercer@example.test',
      });

      expect(result.dropped).toBeFalsy();
      expect(result.jobsFound).toBeGreaterThanOrEqual(1);

      const jobList = Array.from(jobs.values());
      const digestJob = jobList[0];
      expect(digestJob).toBeDefined();

      // Test contact discovery with contact finder
      const mockFinder = {
        findContact: async (domain: string) => `recruiter@${domain}`,
      };

      const discoveredWithFinder = await discoverContact({
        job: {
          company: String(digestJob?.['company']),
          description: String(digestJob?.['description']),
          apply_url: String(digestJob?.['apply_url']),
        },
        finder: mockFinder,
        config: { finderEnabled: true },
        db,
      });

      expect(discoveredWithFinder.contact_email).toBeDefined();

      // When routed with contact finder finding a direct company contact
      const autoDecision = routeJob({
        source_kind: 'api',
        company: 'TechStart Solutions',
        company_normalized: 'techstart solutions',
        contact_source: 'finder',
        contact_email: 'recruiter@techstartsolutions.com',
      });
      expect(autoDecision.route).toBe('auto_email');
      expect(autoDecision.reason).toBe('OK');

      // When contact finder finds freemail or red flags are present -> routes to manual_review
      const reviewDecision = routeJob({
        source_kind: 'api',
        company: 'TechStart Solutions',
        company_normalized: 'techstart solutions',
        contact_source: 'finder',
        contact_email: 'recruiter@gmail.com',
      });
      expect(reviewDecision.route).toBe('manual_review');
      expect(reviewDecision.reason).toBe('FREEMAIL_CONTACT');
    });

    it('c. Malformed email asserts clean failure, no throw, and logged warning', async () => {
      const emlPath = path.join(fixturesDir, 'malformed.eml');
      expect(fs.existsSync(emlPath)).toBe(true);
      const rawEml = fs.readFileSync(emlPath, 'utf8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { db, jobs } = createMockDb();
      let threw = false;
      let result;
      try {
        result = await ingestAlertEmail(rawEml, {
          db,
          envelope: { from: 'alex.mercer@example.test' },
          configuredForwardingAddress: 'alex.mercer@example.test',
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).toBeDefined();
      expect(result?.newJobs).toBe(0);
      expect(jobs.size).toBe(0);

      warnSpy.mockRestore();
    });
  });

  describe('Gmail Alert Poller (Zero-Domain Ingestion)', () => {
    it('searches Gmail, fetches raw EMLs, ingests new jobs, and records audit events', async () => {
      const { db, jobs, events } = createMockDb();
      const encoder = new TextEncoder();

      const mockGmailSender = {
        send: vi.fn(),
        searchSentByMessageId: vi.fn(),
        searchMessages: vi.fn().mockResolvedValue([
          { id: 'msg-whatjobs-101', threadId: 'th-101' },
          { id: 'msg-bebee-102', threadId: 'th-102' },
        ]),
        getRawMessageBytes: vi.fn().mockImplementation(async (msgId: string) => {
          if (msgId === 'msg-whatjobs-101') {
            return encoder.encode(WHATJOBS_EML_FIXTURE);
          }
          if (msgId === 'msg-bebee-102') {
            return encoder.encode(BEBEE_EML_FIXTURE);
          }
          return null;
        }),
      };

      const result = await pollGmailAlerts({
        db,
        gmailSender: mockGmailSender,
      });

      expect(result.success).toBe(true);
      expect(result.messagesFound).toBe(2);
      expect(result.messagesProcessed).toBe(2);
      expect(result.jobsFound).toBe(4);
      expect(result.newJobs).toBe(4);
      expect(jobs.size).toBe(4);

      // Verify audit events recorded in events table
      const auditEvents = events.filter((e) => e.entity === 'gmail_alert');
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents.map((e) => e.entity_id)).toEqual(['msg-whatjobs-101', 'msg-bebee-102']);

      // 2. Test Idempotency: Second poll with same messages skips already processed messages
      const secondPoll = await pollGmailAlerts({
        db,
        gmailSender: mockGmailSender,
      });

      expect(secondPoll.success).toBe(true);
      expect(secondPoll.messagesFound).toBe(2);
      expect(secondPoll.messagesProcessed).toBe(0);
      expect(secondPoll.newJobs).toBe(0);
    });

    it('gracefully handles Gmail search API errors', async () => {
      const { db } = createMockDb();
      const mockGmailSender = {
        send: vi.fn(),
        searchSentByMessageId: vi.fn(),
        searchMessages: vi.fn().mockRejectedValue(new Error('Gmail 503 Service Unavailable')),
        getRawMessageBytes: vi.fn(),
      };

      const result = await pollGmailAlerts({
        db,
        gmailSender: mockGmailSender,
      });

      expect(result.success).toBe(false);
      expect(result.errors).toBe(1);
      expect(result.reason).toContain('Gmail 503');
    });
  });
});
