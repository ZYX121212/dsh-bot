import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTeamPresence } from '../src/bot-presence.mjs';
const p = state => ({ state, label: state });
test('team aggregation does not pretend an unavailable team is idle', () => {
  assert.equal(deriveTeamPresence([p('offline'), p('offline')]).state, 'offline');
  assert.equal(deriveTeamPresence([p('error'), p('idle')]).state, 'error');
  assert.equal(deriveTeamPresence([p('idle'), p('offline')]).label, '部分状态不可用');
});
test('team aggregation prioritizes real attention and work without declaring whole-team completion', () => {
  assert.equal(deriveTeamPresence([p('coding'), p('waiting')]).state, 'waiting');
  assert.equal(deriveTeamPresence([p('completed'), p('researching')]).state, 'researching');
  assert.equal(deriveTeamPresence([p('completed'), p('idle')]).label, '有成员刚完成');
  assert.equal(deriveTeamPresence([]).state, 'idle');
});
