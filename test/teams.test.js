import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName } from '../src/teams.js';

test('sanitizeName drops characters Teams rejects in guest names', () => {
  assert.equal(sanitizeName('Ma-Jod AI (บันทึกประชุม)'), 'Ma-Jod AI บันทึกประชุม');
  assert.equal(sanitizeName("Ma-Jod AI - บันทึกประชุม"), 'Ma-Jod AI - บันทึกประชุม');
  assert.equal(sanitizeName("O'Neil_bot@x.y"), "O'Neil_bot@x.y");
});
