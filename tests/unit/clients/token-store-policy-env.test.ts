/**
 * The client loads the token store with dotenv override: true at import, so each
 * case writes a real temp token store and re-imports the module with a fresh
 * registry to exercise the host-vs-file mutation policy conflict check.
 */
import { jest, describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_ENV = {
  QUICKBOOKS_CLIENT_ID: 'test-client-id',
  QUICKBOOKS_CLIENT_SECRET: 'test-client-secret',
  QUICKBOOKS_REFRESH_TOKEN: 'initial-token',
  QUICKBOOKS_REALM_ID: '99999',
  QUICKBOOKS_ENVIRONMENT: 'sandbox',
  QUICKBOOKS_REDIRECT_URI: 'http://localhost:8000/callback',
};
const POLICY_KEYS = [
  'QUICKBOOKS_WRITE_MODE',
  'QUICKBOOKS_UPDATE_MODE',
  'QUICKBOOKS_DELETE_MODE',
  'QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS',
  'QUICKBOOKS_APPROVAL_AUDIT_LOG',
  'QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH',
  'QUICKBOOKS_DISABLE_UPDATE',
];

class MockOAuthClient {
  static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
  constructor(_cfg: Record<string, unknown>) {}
}

function registerMocks() {
  jest.unstable_mockModule('intuit-oauth', () => ({ default: MockOAuthClient }));
  jest.unstable_mockModule('node-quickbooks', () => ({
    default: class MockQuickBooks { constructor(..._args: unknown[]) {} },
  }));
  jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));
}

let tempDir: string;
let storePath: string;
const savedEnv = { ...process.env };

async function importClient(hostEnv: Record<string, string>, fileContents: string) {
  fs.writeFileSync(storePath, fileContents);
  for (const key of POLICY_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, hostEnv, { QUICKBOOKS_TOKEN_STORE_PATH: storePath });
  jest.resetModules();
  registerMocks();
  return import('../../../src/clients/quickbooks-client');
}

describe('token store vs host mutation policy variables', () => {
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-policy-env-'));
    storePath = path.join(tempDir, 'tokens.env');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('refuses to load when the token store changes a host-set policy value', async () => {
    const load = importClient(
      { QUICKBOOKS_UPDATE_MODE: 'approval', QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS: '60' },
      'QUICKBOOKS_UPDATE_MODE=allow\nQUICKBOOKS_APPROVAL_TIMEOUT_SECONDS=3600\nQUICKBOOKS_REFRESH_TOKEN=secret-file-token\n',
    );
    await expect(load).rejects.toThrow(
      `Mutation policy variable(s) QUICKBOOKS_UPDATE_MODE, QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS set in the host environment differ from the token store file ${storePath}`,
    );
    const message = await load.catch((error: Error) => error.message);
    for (const value of ['approval', 'allow', '3600', 'secret-file-token']) {
      expect(message).not.toContain(value);
    }
  });

  it('loads when the token store repeats the host value', async () => {
    const { quickbooksClient } = await importClient(
      { QUICKBOOKS_DELETE_MODE: 'approval' },
      'QUICKBOOKS_DELETE_MODE=approval\n',
    );
    expect(quickbooksClient).toBeDefined();
    expect(process.env.QUICKBOOKS_DELETE_MODE).toBe('approval');
  });

  it.each([
    ['mode case and whitespace', { QUICKBOOKS_UPDATE_MODE: 'Approval' }, 'QUICKBOOKS_UPDATE_MODE=" approval "\n'],
    ['mode case in the token store', { QUICKBOOKS_WRITE_MODE: ' disabled ' }, 'QUICKBOOKS_WRITE_MODE=DISABLED\n'],
    ['approval value whitespace', { QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS: ' 60 ' }, 'QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS="60"\n'],
  ])('loads when host and token store differ only in %s', async (_label, hostEnv, fileContents) => {
    const { quickbooksClient } = await importClient(hostEnv, fileContents);
    expect(quickbooksClient).toBeDefined();
  });

  it('refuses to load when an approval value differs only in case', async () => {
    await expect(
      importClient({ QUICKBOOKS_APPROVAL_AUDIT_LOG: 'true' }, 'QUICKBOOKS_APPROVAL_AUDIT_LOG=TRUE\n'),
    ).rejects.toThrow('Mutation policy variable(s) QUICKBOOKS_APPROVAL_AUDIT_LOG set in the host environment differ');
  });

  it('refuses to load when normalized mode values differ', async () => {
    await expect(
      importClient({ QUICKBOOKS_DELETE_MODE: ' Approval ' }, 'QUICKBOOKS_DELETE_MODE=allow\n'),
    ).rejects.toThrow('Mutation policy variable(s) QUICKBOOKS_DELETE_MODE set in the host environment differ');
  });

  it('lets the token store fill a blank host value', async () => {
    await importClient({ QUICKBOOKS_WRITE_MODE: '  ' }, 'QUICKBOOKS_WRITE_MODE=approval\n');
    expect(process.env.QUICKBOOKS_WRITE_MODE).toBe('approval');
  });

  it('keeps the host value when the token store omits the key', async () => {
    await importClient({ QUICKBOOKS_APPROVAL_AUDIT_LOG: 'true' }, 'QUICKBOOKS_REFRESH_TOKEN=file-token\n');
    expect(process.env.QUICKBOOKS_APPROVAL_AUDIT_LOG).toBe('true');
    expect(process.env.QUICKBOOKS_REFRESH_TOKEN).toBe('file-token');
  });

  it('still lets the token store override legacy disable flags', async () => {
    await importClient({ QUICKBOOKS_DISABLE_UPDATE: 'true' }, 'QUICKBOOKS_DISABLE_UPDATE=false\n');
    expect(process.env.QUICKBOOKS_DISABLE_UPDATE).toBe('false');
  });
});
