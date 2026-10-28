import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, readCredential, redactError } from '../lib/settings.mjs';

test('defaults are profitable with no auto spending or loss mode', async () => {
  const s = await loadSettings({});
  assert.equal(s.marginBps, 500);
  assert.equal(s.executeTopup, false);
  assert.equal(s.lossTest, false);
  assert.equal(s.surplusBaseUrl, 'https://api.surplusintelligence.ai/v1');
  assert.equal(s.stateDir.endsWith('.state'), true);
});
test('rejects untrusted credential destinations and bad margin', async () => {
  await assert.rejects(loadSettings({ SURPLUS_BASE_URL: 'http://example.com/v1' }), /Surplus origin/);
  await assert.rejects(loadSettings({ MARGIN_BPS: '-1' }), /MARGIN_BPS/);
  await assert.rejects(loadSettings({ MODELS: 'gpt-oss-120b,,x' }), /MODELS/);
});
test('loss testing requires an explicit expiry and finite request limit', async () => {
  await assert.rejects(loadSettings({ LOSS_TEST: 'true' }), /LOSS_TEST/);
  const s = await loadSettings({ LOSS_TEST: 'true', LOSS_TEST_UNTIL: new Date(Date.now()+60_000).toISOString(), LOSS_TEST_MAX_REQUESTS: '2' });
  assert.equal(s.lossMaxRequests, 2);
  await assert.rejects(loadSettings({ LOSS_TEST: 'true', LOSS_TEST_UNTIL: '2020-01-01T00:00:00Z', LOSS_TEST_MAX_REQUESTS: '2' }), /LOSS_TEST/);
});
test('credential can come from owner-only plain file, never from loose permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seller-settings-'));
  const path=join(dir,'key'); await writeFile(path,'inf_testsecret\n',{mode:0o600});
  assert.equal(await readCredential({SURPLUS_API_KEY_FILE:path}), 'inf_testsecret');
  await chmod(path,0o644);
  await assert.rejects(readCredential({SURPLUS_API_KEY_FILE:path}), /permissions/);
});
test('inline credentials reject admin tokens and malformed values before any upstream call',async()=>{
 await assert.rejects(()=>readCredential({SURPLUS_API_KEY:'inf_admin_fixture'}),/inference credential/);
 await assert.rejects(()=>readCredential({SURPLUS_API_KEY:'not-a-key'}),/inference credential/);
 assert.equal(await readCredential({SURPLUS_API_KEY:'inf_fixture_inference'}),'inf_fixture_inference');
});
test('errors redact bearer keys, private keys, URLs with tokens',()=>{
  const value = redactError(new Error('bad Bearer inf_secret0123 private 0x'+'a'.repeat(64)+' https://rpc.test/v2/secret'));
  assert.equal(value.includes('inf_secret0123'),false);
  assert.equal(value.includes('a'.repeat(64)),false);
  assert.equal(value.includes('/v2/secret'),false);
});
