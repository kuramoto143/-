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

test('今日・明日・明後日に分かれ、期限切れ・完了・保留は出ない', () => {
  const values = [HEADER,
    row('ケント', 'ちいかわ回', '台本', 'takuma', '2026/11/14', '', '未着手'),
    row('ケント', 'ちいかわ回', '編集・提出', '倉本', '2026/11/15', '17:00', '未着手'),
    row('ろびん', 'アキネーター①', '投稿予約', '倉本', '2026/11/15', '', '未着手'),
    row('ろびん', '最強主人公', '編集・提出', '倉本', '2026/11/16', '', '作業中'),
    row('ケント', '実用回', '台本', 'takuma', '2026/11/17', '', '未着手'),
    row('ケント', '別の回', '台本', 'takuma', '2026/11/18', '', '未着手'),
    row('一期一会', 'DQ5', '修正', '倉本', '', '', '作業中'),
    row('ろびん', '済んだもの', '修正', '倉本', '2026/11/15', '', '完了'),
    row('くみ', '', 'その他', 'takuma', '2026/11/15', '', '保留'),
    ['', '', '', '', '', '', '', '', '', '']
  ];
  values[5][7] = '2026/11/18'; // 実用回の投稿予定日
  const tasks = gas.parseRows(values, '2026-11-15');
  const c = gas.classify(tasks, '2026-11-15');
  assert.deepEqual([c.overdue.length, c.today.length, c.tomorrow.length, c.dayAfter.length, c.later.length, c.noDue.length], [1, 2, 1, 1, 1, 1]);
  assert.equal(c.today[0].time, '17:00'); // 時刻ありが先

  const text = gas.buildMorningMessage(tasks, '2026-11-15', 'https://example.com/page');
  assert.equal(text, [
    '【制作の期限】11/15(日)',
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
    '■ 明後日が期限（1件）',
    '〔takuma〕',
    '・ケント／11/18(水)投稿分（実用回） 台本［未着手］',
    '',
    '期限未設定：1件',
    '',
    'https://example.com/page'
  ].join('\n'));
});

test('該当なしの日と、読めない期限日', () => {
  const values = [HEADER, row('ろびん', 'A', '修正', '倉本', '来週', '', '作業中')];
  const text = gas.buildMorningMessage(gas.parseRows(values, '2026-11-15'), '2026-11-15', '');
  assert.match(text, /■ 明後日が期限（0件）\nなし/);
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

test('カード形式：倉本が先、空の文字なし、容量内', () => {
  const values = [HEADER,
    row('ケント', 'ちいかわ回', '台本', 'takuma', '2026/11/15', '12:30', '未着手'),
    row('ケント', 'ちいかわ回', '編集・提出', '倉本', '2026/11/15', '17:00', '未着手'),
    row('管理', '', 'その他', '倉本', '2026/11/15', '', '作業中'),
    row('ろびん', '最強主人公', '編集・提出', '倉本', '2026/11/16', '', '作業中'),
    row('一期一会', 'DQ5', '修正', '倉本', '', '', '作業中')
  ];
  const tasks = gas.parseRows(values, '2026-11-15');
  const msg = gas.buildFlexMessage(tasks, '2026-11-15', { page: 'https://script.google.com/x' });
  assert.equal(msg.type, 'flex');
  assert.equal(msg.altText, '制作の期限 11/15(日)：今日3件・明日1件・明後日0件');
  const texts = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.type === 'text') { assert.ok(n.text.length > 0); texts.push(n.text); }
      Object.values(n).forEach(walk);
    }
  })(msg.contents);
  assert.ok(texts.indexOf('倉本　2件') < texts.indexOf('takuma　1件'));
  assert.ok(texts.includes('期限未設定 1件'));
  assert.equal(msg.contents.footer.contents.length, 1);

  const many = [HEADER];
  for (let i = 0; i < 300; i++) many.push(row('ろびん', '動画' + i, '修正', '倉本', '2026/11/15', '', '作業中'));
  const big = gas.buildFlexMessage(gas.parseRows(many, '2026-11-15'), '2026-11-15', {});
  assert.ok(Buffer.byteLength(JSON.stringify(big.contents)) < 30000);
  assert.ok(JSON.stringify(big).includes('ほか270件はシートで確認'));

  const none = gas.buildFlexMessage([], '2026-11-15', {});
  assert.equal(none.altText, '制作の期限 11/15(日)：今日0件・明日0件・明後日0件');
  assert.equal(none.contents.footer, undefined);
});

test('送信先を複数持てる', () => {
  const a = 'C' + 'a'.repeat(32), b = 'C' + 'b'.repeat(32), u = 'U' + '0'.repeat(32);
  assert.deepEqual([...gas.parseDestinations(a)], [a]);
  assert.deepEqual([...gas.parseDestinations(` ${a} ,\n${b},${a}`)], [a, b]);
  assert.deepEqual([...gas.parseDestinations('2012616293, ,abc')], []);
  assert.deepEqual([...gas.parseDestinations(null)], []);
  assert.equal(gas.addDestination(a, b), a + ',' + b);
  assert.equal(gas.addDestination(a + ',' + b, a), a + ',' + b);
  assert.equal(gas.addDestination('', u), u);
});

test('送信先からIDを除く', () => {
  const a = 'C' + 'a'.repeat(32), b = 'C' + 'b'.repeat(32);
  assert.equal(gas.removeDestinations(a + ',' + b, [b]), a);
  assert.equal(gas.removeDestinations(a, [b]), a);
  assert.equal(gas.removeDestinations('', [a]), '');
});

test('LINEのコマンドを取り出す', () => {
  const g = 'C' + 'a'.repeat(32);
  const ev = (text, extra = {}) => JSON.stringify({ events: [{ type: 'message', replyToken: 'r1',
    source: { type: 'group', groupId: g }, message: { type: 'text', text }, ...extra }] });
  assert.deepEqual(JSON.parse(JSON.stringify(gas.extractCommands(ev('/rm on')))), [{ command: 'resume', replyToken: 'r1', source: g }]);
  assert.equal(gas.extractCommands(ev(' /RM  OFF '))[0].command, 'pause');
  assert.equal(gas.extractCommands(ev('／rm　on'))[0].command, 'resume');
  assert.equal(gas.extractCommands(ev('/status'))[0].command, 'list');
  assert.equal(gas.extractCommands(ev('/help'))[0].command, 'help');
  // 日本語や、文の途中に含まれるものには反応しない
  assert.equal(gas.extractCommands(ev('RM再開')).length, 0);
  assert.equal(gas.extractCommands(ev('rm on')).length, 0);
  assert.equal(gas.extractCommands(ev('/rm on しといて')).length, 0);
  assert.equal(gas.extractCommands(ev('/rmon')).length, 0);
  assert.equal(gas.extractCommands(JSON.stringify({ events: [{ type: 'join', replyToken: 'r', source: { groupId: g } }] })).length, 0);
  assert.equal(gas.extractCommands('壊れた本文').length, 0);
});

test('投稿予定日を2つ書ける', () => {
  const values = [HEADER, row('ろびん', '最強主人公ランキング', '編集・提出', '倉本', '2026/11/17', '', '作業中')];
  values[1][7] = '2026/11/17 or 11/18';
  const t = gas.parseRows(values, '2026-11-17')[0];
  assert.equal(t.postDate, '2026-11-17');
  assert.equal(t.postDate2, '2026-11-18');
  const text = gas.buildMorningMessage([t], '2026-11-17', '');
  assert.match(text, /ろびん／11\/17\(火\) or 18\(水\)投稿分（最強主人公ランキング） 編集・提出/);
  const card = JSON.stringify(gas.buildFlexMessage([t], '2026-11-17', {}));
  assert.ok(card.includes('最強主人公ランキングの編集・提出'));
  assert.ok(card.includes('ろびん・11/17(火) or 18(水)投稿'));
  values[1][7] = '2026/11/17か11/18'; // 「か」で書いても読める
  assert.equal(gas.parseRows(values, '2026-11-17')[0].postDate2, '2026-11-18');
  values[1][7] = '2026/11/17OR11/18';
  assert.equal(gas.parseRows(values, '2026-11-17')[0].postDate2, '2026-11-18');
  values[1][7] = '2026/11/17';
  assert.equal(gas.parseRows(values, '2026-11-17')[0].postDate2, '');
});

test('カードの2行目は「案件・投稿日」に揃う', () => {
  const values = [HEADER,
    row('ケント', 'ちいかわ回', '編集・提出', '倉本', '2026/11/17', '', '作業中'),
    row('ろびん', '直近動画の分析と次回企画', 'その他', 'takuma', '2026/11/17', '', '未着手'),
    row('ロブロックス', '2本目（AI実技系）', '編集・提出', '倉本', '2026/11/18', '', '未着手')];
  values[3][7] = '2026/11/20';
  const card = JSON.stringify(gas.buildFlexMessage(gas.parseRows(values, '2026-11-17'), '2026-11-17', {}));
  ['ちいかわ回の編集・提出', 'ケント・投稿日未定', '直近動画の分析と次回企画', 'ろびん・投稿なし', '2本目（AI実技系）の編集・提出', 'ロブロックス・11/20(金)投稿']
    .forEach(s => assert.ok(card.includes(s), s));
});

test('期限日を2つ書くと、遅いほうの日まで通知に残る', () => {
  const values = [HEADER, row('ケント', 'ちいかわ回', '編集・提出', '倉本', '2026/11/18 or 11/19', '', '作業中')];
  const on17 = gas.parseRows(values, '2026-11-17');
  assert.equal(on17[0].due, '2026-11-19');
  assert.equal(on17[0].dueFirst, '2026-11-18');
  assert.equal(gas.classify(on17, '2026-11-17').dayAfter.length, 1);
  assert.equal(gas.classify(gas.parseRows(values, '2026-11-19'), '2026-11-19').today.length, 1);
  const card = JSON.stringify(gas.buildFlexMessage(on17, '2026-11-17', {}));
  assert.ok(card.includes('"水/木"'));
  assert.match(gas.buildMorningMessage(on17, '2026-11-17', ''), /・水\/木のどちらか ケント／ちいかわ回 編集・提出/);
});
