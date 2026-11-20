import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Bindings } from './env.js';
import {
  claimApplicationCreation,
  releaseApplicationCreationClaim,
} from './application-queue-claims.js';

const workerEnv = env as unknown as Bindings & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

describe('application queue claims', () => {
  beforeAll(async () => {
    await applyD1Migrations(workerEnv.DB, workerEnv.TEST_MIGRATIONS);
    await workerEnv.DB.prepare(
      `INSERT OR IGNORE INTO jobs (
        id, dedupe_key, source, source_kind, title, company, company_normalized,
        description, fetched_at, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        'queue-claim-test-job',
        'queue-claim-test-job',
        'test',
        'api',
        'Test role',
        'Test company',
        'test company',
        'Test description',
        new Date().toISOString(),
        'routed',
        new Date().toISOString(),
      )
      .run();
  });

  it('allows one active claim, reclaims it after expiry, and releases only its own token', async () => {
    const now = Date.now();
    const firstToken = await claimApplicationCreation(
      workerEnv.DB,
      'queue-claim-test-job',
      now,
    );
    expect(firstToken).toBeTruthy();
    if (!firstToken) throw new Error('Expected first application creation claim');
    expect(
      await claimApplicationCreation(workerEnv.DB, 'queue-claim-test-job', now + 1000),
    ).toBeNull();

    const replacementToken = await claimApplicationCreation(
      workerEnv.DB,
      'queue-claim-test-job',
      now + 31 * 60 * 1000,
    );
    expect(replacementToken).toBeTruthy();
    if (!replacementToken) throw new Error('Expected replacement application creation claim');
    expect(replacementToken).not.toBe(firstToken);

    await releaseApplicationCreationClaim(workerEnv.DB, 'queue-claim-test-job', firstToken);
    expect(
      await claimApplicationCreation(
        workerEnv.DB,
        'queue-claim-test-job',
        now + 31 * 60 * 1000 + 1000,
      ),
    ).toBeNull();

    await releaseApplicationCreationClaim(
      workerEnv.DB,
      'queue-claim-test-job',
      replacementToken,
    );
    expect(
      await claimApplicationCreation(
        workerEnv.DB,
        'queue-claim-test-job',
        now + 31 * 60 * 1000 + 2000,
      ),
    ).toBeTruthy();
  });
});
