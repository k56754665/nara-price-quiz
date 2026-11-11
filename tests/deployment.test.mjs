import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function checkRelease(t, question) {
  const tempRoot = await realpath(tmpdir());
  const fixture = await mkdtemp(path.join(tempRoot, 'nara-release-gate-'));
  t.after(async () => {
    const target = await realpath(fixture);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith('nara-release-gate-'));
    await rm(target, { recursive: true, force: true });
  });
  await mkdir(path.join(fixture, 'scripts'));
  await mkdir(path.join(fixture, 'dist'));
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  await copyFile(new URL('../scripts/verify-ranking.mjs', import.meta.url), path.join(fixture, 'scripts/verify-ranking.mjs'));
  for (const name of ['engine.js', 'leaderboard.js']) {
    await copyFile(new URL('../dist/' + name, import.meta.url), path.join(fixture, 'dist', name));
  }
  // Disable live ranking in this isolated fixture; deployment checks never write to the DB.
  await writeFile(path.join(fixture, 'dist/leaderboard-config.js'), 'export const LEADERBOARD_CONFIG = {};');
  await writeFile(path.join(fixture, 'dist/data.json'), JSON.stringify({ questions: [question] }));
  return spawnSync(process.execPath, ['scripts/verify-ranking.mjs'], { cwd: fixture, encoding: 'utf8' });
}

test('확인 시각이 24시간보다 오래되어도 유효한 계약이면 배포 검사를 통과', async t => {
  const result = await checkRelease(t, { checkedAt: '2000-01-01T00:00:00.000Z', contractEnd: '2999-12-31' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ranking is disabled/);
});

test('확인 시각이 잘못된 품목은 배포 검사에서 거부', async t => {
  const result = await checkRelease(t, { checkedAt: 'invalid', contractEnd: '2999-12-31' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /확인 시각이 누락되었거나 잘못된 품목/);
});

test('확인 시각의 경과 시간과 관계없이 만료된 계약은 배포 검사에서 거부', async t => {
  const result = await checkRelease(t, { checkedAt: '2000-01-01T00:00:00.000Z', contractEnd: '2000-01-01' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /계약 유효기간이 지난 품목/);
});
