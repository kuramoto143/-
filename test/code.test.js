// 実行: node --test test/code.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../gas/Code.gs'), 'utf8'), sandbox);
const gas = sandbox.module.exports;

const HEADER = ['案件', '動画・内容', '作業', '担当', '期限日', '期限時刻', '状態', '投稿予定日', 'メモ', 'リンク'];
const row = (project, title, work, owner, due, time, status) =>
  [project, title, work, owner, due, time, status, '', '', ''];

test('日付と時刻の読み取り', () => {
  assert.equal(gas.normalizeDate('2026/11/5'), '2026-11-05');
  assert.equal(gas.normalizeDate('2026-11-15'), '2026-11-15');
  assert.equal(gas.normalizeDate('11/5', '2026-11-15'), '2026-11-05');
  assert.equal(gas.normalizeDate('2026/2/30'), '');
  assert.equal(gas.normalizeDate('来週'), '');
  assert.equal(gas.normalizeTime('9:5'), '09:05');
  assert.equal(gas.normalizeTime('１８：００'), '18:00');
  assert.equal(gas.normalizeTime('25:00'), '');
  assert.equal(gas.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(gas.formatShort('2026-11-15'), '11/15(日)');
});

test('列の並びが変わっても列名で読む', () => {
  const values = [
    ['状態', '案件', '動画・内容', '作業', '担当', '期限日', '期限時刻', '投稿予定日', 'メモ', 'リンク'],
    ['作業中', 'ろびん', 'A', '修正', '倉本', '2026/11/16', '', '', '', '']
  ];
  const t = gas.parseRows(values, '2026-11-15')[0];
  assert.equal(t.status, '作業中');
  assert.equal(t.due, '2026-11-16');
  assert.equal(t.row, 2);
});

test('列が足りないときはエラーで知らせる', () => {
  assert.throws(() => gas.parseRows([['案件', '担当']], '2026-11-15'), /列がありません/);
});

test('期限切れ・今日・明日・未設定に分かれ、完了と保留は外れる', () => {
  const values = [HEADER,
    row('ケント', 'ちいかわ回', '台本', 'takuma', '2026/11/14', '', '未着手'),
    row('ケント', 'ちいかわ回', '編集・提出', '倉本', '2026/11/15', '17:00', '未着手'),
    row('ろびん', 'アキネーター①', '投稿予約', '倉本', '2026/11/15', '', '未着手'),
    row('ろびん', '最強主人公', '編集・提出', '倉本', '2026/11/16', '', '作業中'),
    row('一期一会', 'DQ5', '修正', '倉本', '', '', '作業中'),
    row('ろびん', '済んだもの', '修正', '倉本', '2026/11/10', '', '完了'),
    row('くみ', '', 'その他', 'takuma', '2026/11/10', '', '保留'),
    ['', '', '', '', '', '', '', '', '', '']
  ];
  const tasks = gas.parseRows(values, '2026-11-15');
  assert.equal(tasks.length, 7);
  const c = gas.classify(tasks, '2026-11-15');
  assert.deepEqual([c.overdue.length, c.today.length, c.tomorrow.length, c.noDue.length], [1, 2, 1, 1]);
  assert.equal(c.today[0].time, '17:00'); // 時刻ありが先

  const text = gas.buildMorningMessage(tasks, '2026-11-15', 'https://example.com/page');
  assert.equal(text, [
    '【制作の期限】11/15(日)',
    '',
    '■ 期限切れ（1件）',
    '〔takuma〕',
    '・11/14(土) ケント／ちいかわ回 台本［未着手］',
    '',
    '■ 今日が期限（2件）',
    '〔倉本〕',
    '・17:00 ケント／ちいかわ回 編集・提出［未着手］',
    '・ろびん／アキネーター① 投稿予約［未着手］',
    '',
    '■ 明日が期限（1件）',
    '〔倉本〕',
    '・ろびん／最強主人公 編集・提出［作業中］',
    '',
    '期限未設定：1件',
    '',
    'https://example.com/page'
  ].join('\n'));
});

test('該当なしの日と、読めない期限日', () => {
  const values = [HEADER, row('ろびん', 'A', '修正', '倉本', '来週', '', '作業中')];
  const text = gas.buildMorningMessage(gas.parseRows(values, '2026-11-15'), '2026-11-15', '');
  assert.match(text, /ものはありません/);
  assert.match(text, /期限日を読めない行：2行目/);
});

test('5000文字を超えない', () => {
  const values = [HEADER];
  for (let i = 0; i < 400; i++) values.push(row('ろびん', '動画' + i, '修正', '倉本', '2026/11/15', '', '作業中'));
  const text = gas.buildMorningMessage(gas.parseRows(values, '2026-11-15'), '2026-11-15', '');
  assert.ok(text.length <= 5000);
});

test('Webhookの本文からグループIDを取り出す', () => {
  const gid = 'C' + 'a1b2c3d4'.repeat(4);
  const join = JSON.stringify({ events: [{ type: 'join', source: { type: 'group', groupId: gid } }] });
  assert.equal(gas.extractGroupId(join), gid);
  const mixed = JSON.stringify({ events: [
    { type: 'message', source: { type: 'user', userId: 'U' + '0'.repeat(32) } },
    { type: 'message', source: { type: 'group', groupId: gid, userId: 'U' + '0'.repeat(32) } }
  ] });
  assert.equal(gas.extractGroupId(mixed), gid);
  // 個人トーク、検証用の空イベント、壊れた本文、形の違うIDは無視する
  assert.equal(gas.extractGroupId(JSON.stringify({ events: [{ source: { type: 'user', userId: 'U' + '0'.repeat(32) } }] })), '');
  assert.equal(gas.extractGroupId(JSON.stringify({ events: [] })), '');
  assert.equal(gas.extractGroupId('not json'), '');
  assert.equal(gas.extractGroupId(JSON.stringify({ events: [{ source: { type: 'group', groupId: 'https://example.com' } }] })), '');
});
