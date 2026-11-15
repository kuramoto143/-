/**
 * ROBIN 制作管理：毎朝のLINE通知と、閲覧ページ。
 * スプレッドシートに紐づけたApps Scriptに貼り付けて使う。
 *
 * スクリプト プロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   LINE_TOKEN : LINE Messaging API のチャネルアクセストークン（長期）
 *   LINE_TO    : 送信先のユーザーID（Uで始まる33文字）。グループIDやルームIDも使える
 *   PAGE_URL   : 閲覧ページのURL（任意。入れると通知の末尾に付く）
 */

var SHEET_NAME = 'タスク';
var TZ = 'Asia/Tokyo';
var SEND_HOUR = 8; // 毎朝の送信時刻（時）。実際の送信は前後15分ほどずれる
var CLOSED_STATUSES = ['完了', '保留'];
var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
var LINE_TEXT_LIMIT = 5000;

// 列名（シート1行目）と、コード内で使う名前の対応
var COLUMNS = {
  '案件': 'project',
  '動画・内容': 'title',
  '作業': 'work',
  '担当': 'owner',
  '期限日': 'due',
  '期限時刻': 'time',
  '状態': 'status',
  '投稿予定日': 'postDate',
  'メモ': 'memo',
  'リンク': 'link'
};

/* ---------- 日付の処理（Apps Scriptに依存しない） ---------- */

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** '2026/11/5' '2026-11-05' '11/5' を 'YYYY-MM-DD' にする。読めなければ ''。 */
function normalizeDate(text, today) {
  var s = String(text == null ? '' : text).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  var y, mo, d;
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else {
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
    if (!m || !today) return '';
    y = +today.slice(0, 4); mo = +m[1]; d = +m[2];
  }
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + pad2(mo) + '-' + pad2(d);
}

/** '9:5' や '９：００' を 'HH:MM' にする。読めなければ ''。 */
function normalizeTime(text) {
  var s = String(text == null ? '' : text).trim()
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace('：', ':');
  var m = s.match(/^(\d{1,2}):(\d{1,2})/);
  if (!m || +m[1] > 23 || +m[2] > 59) return '';
  return pad2(+m[1]) + ':' + pad2(+m[2]);
}

function addDays(ymd, n) {
  var p = ymd.split('-');
  var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

/** 'YYYY-MM-DD' を '11/15(日)' にする。 */
function formatShort(ymd) {
  var p = ymd.split('-');
  var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return (+p[1]) + '/' + (+p[2]) + '(' + WEEKDAYS[dt.getUTCDay()] + ')';
}

/* ---------- シートの行をタスクに変換 ---------- */

/** getDisplayValues() の2次元配列を、タスクの配列にする。 */
function parseRows(values, today) {
  if (!values || !values.length) return [];
  var header = values[0].map(function (h) { return String(h).trim(); });
  var index = {};
  Object.keys(COLUMNS).forEach(function (name) {
    var i = header.indexOf(name);
    if (i === -1) throw new Error('「' + SHEET_NAME + '」シートの1行目に「' + name + '」列がありません。');
    index[COLUMNS[name]] = i;
  });
  var tasks = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var get = function (key) { return String(row[index[key]] == null ? '' : row[index[key]]).trim(); };
    if (!get('project') && !get('title')) continue;
    var dueRaw = get('due');
    tasks.push({
      row: r + 1,
      project: get('project'),
      title: get('title'),
      work: get('work'),
      owner: get('owner') || '担当未定',
      due: normalizeDate(dueRaw, today),
      dueUnreadable: !!dueRaw && !normalizeDate(dueRaw, today),
      time: normalizeTime(get('time')),
      status: get('status') || '未着手',
      postDate: normalizeDate(get('postDate'), today),
      memo: get('memo'),
      link: get('link')
    });
  }
  return tasks;
}

function isOpen(task) {
  return CLOSED_STATUSES.indexOf(task.status) === -1;
}

function byDueThenTime(a, b) {
  if (a.due !== b.due) return a.due < b.due ? -1 : 1;
  var ta = a.time || '99:99', tb = b.time || '99:99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.row - b.row;
}

/** 未完了のタスクを、期限切れ・今日・明日・それ以降・期限未設定に分ける。 */
function classify(tasks, today) {
  var tomorrow = addDays(today, 1);
  var out = { overdue: [], today: [], tomorrow: [], later: [], noDue: [] };
  tasks.filter(isOpen).forEach(function (t) {
    if (!t.due) out.noDue.push(t);
    else if (t.due < today) out.overdue.push(t);
    else if (t.due === today) out.today.push(t);
    else if (t.due === tomorrow) out.tomorrow.push(t);
    else out.later.push(t);
  });
  ['overdue', 'today', 'tomorrow', 'later'].forEach(function (k) { out[k].sort(byDueThenTime); });
  return out;
}

/* ---------- LINEに送る文面 ---------- */

function taskLabel(t) {
  var name = t.project + (t.title ? '／' + t.title : '');
  return name + (t.work && t.work !== 'その他' ? ' ' + t.work : '');
}

function groupByOwner(list) {
  var order = [], map = {};
  list.forEach(function (t) {
    if (!map[t.owner]) { map[t.owner] = []; order.push(t.owner); }
    map[t.owner].push(t);
  });
  return order.map(function (o) { return { owner: o, tasks: map[o] }; });
}

function section(title, list, showDate) {
  if (!list.length) return [];
  var lines = ['', '■ ' + title + '（' + list.length + '件）'];
  groupByOwner(list).forEach(function (g) {
    lines.push('〔' + g.owner + '〕');
    g.tasks.forEach(function (t) {
      var head = [];
      if (showDate) head.push(formatShort(t.due));
      if (t.time) head.push(t.time);
      lines.push('・' + (head.length ? head.join(' ') + ' ' : '') + taskLabel(t) + '［' + t.status + '］');
    });
  });
  return lines;
}

/** 毎朝の通知文を作る。 */
function buildMorningMessage(tasks, today, pageUrl) {
  var c = classify(tasks, today);
  var lines = ['【制作の期限】' + formatShort(today)];
  var body = []
    .concat(section('期限切れ', c.overdue, true))
    .concat(section('今日が期限', c.today, false))
    .concat(section('明日が期限', c.tomorrow, false));
  if (!body.length) body = ['', '期限切れ、今日が期限、明日が期限のものはありません。'];
  lines = lines.concat(body);

  var notes = [];
  if (c.noDue.length) notes.push('期限未設定：' + c.noDue.length + '件');
  var unreadable = tasks.filter(function (t) { return t.dueUnreadable; });
  if (unreadable.length) {
    notes.push('期限日を読めない行：' + unreadable.map(function (t) { return t.row + '行目'; }).join('、'));
  }
  if (notes.length) lines = lines.concat([''], notes);
  if (pageUrl) lines = lines.concat(['', pageUrl]);

  var text = lines.join('\n');
  if (text.length > LINE_TEXT_LIMIT) {
    var tail = '\n…（長いため省略。続きはシートで確認）';
    text = text.slice(0, LINE_TEXT_LIMIT - tail.length) + tail;
  }
  return text;
}

/* ---------- グループIDの受け取り ---------- */

/**
 * LINEから届いたWebhookの本文（JSON文字列）から、グループIDまたはルームIDを1つ取り出す。
 * botがグループに参加したとき、またはグループ内で誰かが発言したときの通知に入っている。
 */
function extractGroupId(bodyText) {
  var body;
  try { body = JSON.parse(bodyText); } catch (err) { return ''; }
  var events = body && body.events;
  if (!events || !events.length) return '';
  for (var i = 0; i < events.length; i++) {
    var src = events[i] && events[i].source;
    if (!src) continue;
    var id = src.type === 'group' ? src.groupId : (src.type === 'room' ? src.roomId : '');
    if (/^[CR][0-9a-f]{32}$/.test(String(id || ''))) return id;
  }
  return '';
}

/* ---------- ここから下はApps Scriptの機能を使う ---------- */

/**
 * LINEのWebhookの受け口。グループIDを LINE_GROUP_ID に控えるだけで、送信先は変えない。
 * 送信先の切り替えは useGroup() を手で実行したときだけ行う。
 */
function doPost(e) {
  var id = extractGroupId(e && e.postData ? e.postData.contents : '');
  if (id) PropertiesService.getScriptProperties().setProperty('LINE_GROUP_ID', id);
  return ContentService.createTextOutput('ok');
}

/** 控えておいたグループを送信先にして、確認の1通を送る。 */
function useGroup() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('LINE_GROUP_ID');
  if (!id) throw new Error('グループIDをまだ受け取っていません。botをグループに招待し、グループで何か1通送ってから実行してください。');
  props.setProperty('LINE_TO', id);
  pushLine_('このグループに、毎朝の制作期限を送ります。');
}

function todayString_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function readTasks_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('「' + SHEET_NAME + '」という名前のシートがありません。');
  return parseRows(sheet.getDataRange().getDisplayValues(), todayString_());
}

function pushLine_(text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('LINE_TOKEN');
  var to = props.getProperty('LINE_TO');
  if (!token || !to) throw new Error('スクリプト プロパティに LINE_TOKEN と LINE_TO を設定してください。');
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('LINEへの送信に失敗しました（' + code + '）：' + res.getContentText());
}

/** 毎朝のトリガーから呼ばれる。手動で実行すると、その場で1通送る。 */
function sendMorningDigest() {
  var pageUrl = PropertiesService.getScriptProperties().getProperty('PAGE_URL') || '';
  pushLine_(buildMorningMessage(readTasks_(), todayString_(), pageUrl));
}

/** 毎朝の通知を登録する。何度実行しても通知は1日1回のまま。 */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendMorningDigest')
    .timeBased().everyDays(1).atHour(SEND_HOUR).nearMinute(0).inTimezone(TZ).create();
}

/** 毎朝の通知を止める。 */
function stopDigest() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningDigest') ScriptApp.deleteTrigger(t);
  });
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('制作管理')
    .addItem('今すぐLINEに送る', 'sendMorningDigest')
    .addItem('毎朝' + SEND_HOUR + '時の通知を登録する', 'setup')
    .addItem('毎朝の通知を止める', 'stopDigest')
    .addItem('送信先をグループに切り替える', 'useGroup')
    .addToUi();
}

/* ---------- 閲覧ページ ---------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ROBIN 制作管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 閲覧ページから呼ばれる。 */
function getData() {
  return {
    today: todayString_(),
    loadedAt: Utilities.formatDate(new Date(), TZ, 'M/d HH:mm'),
    sheetUrl: SpreadsheetApp.getActive().getUrl(),
    tasks: readTasks_()
  };
}

// テスト用（Apps Script上では何もしない）
if (typeof module !== 'undefined') {
  module.exports = {
    normalizeDate: normalizeDate, normalizeTime: normalizeTime, addDays: addDays,
    formatShort: formatShort, parseRows: parseRows, classify: classify,
    buildMorningMessage: buildMorningMessage, extractGroupId: extractGroupId
  };
}
