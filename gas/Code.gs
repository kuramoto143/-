/**
 * ROBIN 制作管理：毎朝のLINE通知と、閲覧ページ。
 * スプレッドシートに紐づけたApps Scriptに貼り付けて使う。
 *
 * スクリプト プロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   LINE_TOKEN : LINE Messaging API のチャネルアクセストークン（長期）
 *   LINE_TO    : 送信先のID。グループIDやユーザーIDをカンマ区切りで複数入れられる
 *   PAGE_URL   : 閲覧ページのURL（任意。入れると通知の末尾に付く）
 */

var CODE_VERSION = '2026-11-25a'; // コードを直したら更新する。selfCheck でデプロイ済みの版と比べる
var SHEET_NAME = 'タスク';
var LOG_SHEET_NAME = 'LINEログ'; // botが受け取ったグループの発言を書き残すタブ
var TZ = 'Asia/Tokyo';
var SEND_HOUR = 8; // 毎朝の送信時刻（時）。この時刻の00分00秒に送る（setup を参照）
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

/** 「2026/11/17 or 11/18」のような欄を、日付（YYYY-MM-DD）の配列にする。2つまで。 */
function splitDates_(text, today) {
  return String(text == null ? '' : text).split(/\s*(?:or|か|〜|~|、|,|または)\s*/i)
    .map(function (d) { return normalizeDate(d, today); }).filter(function (d) { return d; }).slice(0, 2);
}

/** 期限日が2つあるときの短い表記（水/木）。1つなら ''。 */
function dueDays(t) {
  if (!t.dueFirst) return '';
  var w = function (ymd) { return formatShort(ymd).replace(/^.*\((.)\)$/, '$1'); };
  return w(t.dueFirst) + '/' + w(t.due);
}

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
    // 期限日も「2026/11/18 or 11/19」のように2つまで書ける。区分けは遅いほう（本当の締め切り）で行う
    var dues = splitDates_(dueRaw, today);
    // 投稿予定日は「2026/11/17 or 11/18」のように2つまで書ける（どちらかに投稿する場合）
    var postDates = splitDates_(get('postDate'), today);
    tasks.push({
      row: r + 1,
      project: get('project'),
      title: get('title'),
      work: get('work'),
      owner: get('owner') || '担当未定',
      due: dues.length ? dues[dues.length - 1] : '',
      dueFirst: dues.length > 1 ? dues[0] : '',
      dueUnreadable: !!dueRaw && !dues.length,
      time: normalizeTime(get('time')),
      status: get('status') || '未着手',
      postDate: postDates[0] || '',
      postDate2: postDates[1] || '',
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

/** 未完了のタスクを、期限切れ・今日・明日・明後日・それ以降・期限未設定に分ける。 */
function classify(tasks, today) {
  var tomorrow = addDays(today, 1), dayAfter = addDays(today, 2);
  var out = { overdue: [], today: [], tomorrow: [], dayAfter: [], later: [], noDue: [] };
  tasks.filter(isOpen).forEach(function (t) {
    if (!t.due) out.noDue.push(t);
    else if (t.due < today) out.overdue.push(t);
    else if (t.due === today) out.today.push(t);
    else if (t.due === tomorrow) out.tomorrow.push(t);
    else if (t.due === dayAfter) out.dayAfter.push(t);
    else out.later.push(t);
  });
  ['overdue', 'today', 'tomorrow', 'dayAfter', 'later'].forEach(function (k) { out[k].sort(byDueThenTime); });
  return out;
}

/* ---------- LINEに送る文面 ---------- */

/** 動画名。投稿予定日があれば「（11/18投稿分）」を付けて、どの回か分かるようにする。 */
/** 「11/17(火)投稿分」または「11/17(火) or 11/18(水)投稿分」。投稿日が無ければ ''。 */
function postLabel(t) {
  if (!t.postDate) return '';
  var second = '';
  if (t.postDate2) {
    // 同じ月なら2つ目の月を省く（11/17(火) or 18(水)）
    second = formatShort(t.postDate2);
    if (t.postDate2.slice(0, 7) === t.postDate.slice(0, 7)) second = second.replace(/^\d+\//, '');
    second = ' or ' + second;
  }
  return formatShort(t.postDate) + second + '投稿分';
}

function videoName(t) {
  var name = t.title || t.project;
  return t.postDate ? postLabel(t) + '（' + name + '）' : name;
}

function taskLabel(t) {
  var name = t.project + (t.title ? '／' + videoName(t) : '');
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
  var lines = ['', '■ ' + title + '（' + list.length + '件）'];
  if (!list.length) return lines.concat(['なし']);
  groupByOwner(list).forEach(function (g) {
    lines.push('〔' + g.owner + '〕');
    g.tasks.forEach(function (t) {
      var head = [];
      if (showDate) head.push(formatShort(t.due));
      if (t.dueFirst) head.push(dueDays(t) + 'のどちらか');
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
    .concat(section('今日が期限', c.today, false))
    .concat(section('明日が期限', c.tomorrow, false))
    .concat(section('明後日が期限', c.dayAfter, false));
  lines = lines.concat(body);

  var notes = [];
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

/* ---------- LINEに送るカード（Flex Message） ---------- */

var ME = '倉本'; // この担当を各区分の先頭に出す
var FLEX_MAX_ROWS = 30; // カードに載せる行数の上限（LINEの容量制限に収めるため）
var FX = { ink: '#111C2E', sub: '#8A93A3', line: '#E6E9EE', red: '#C0392B', amber: '#B26A00', blue: '#1D4ED8', green: '#17663A' };
var STATUS_COLORS = { '未着手': FX.sub, '作業中': FX.blue, '確認待ち': FX.amber, '完了': FX.green, '保留': FX.sub };

function fxText(text, opts) {
  var t = { type: 'text', text: String(text == null || text === '' ? ' ' : text) };
  Object.keys(opts || {}).forEach(function (k) { t[k] = opts[k]; });
  return t;
}

function fxRow(t, showDate) {
  var when = showDate ? formatShort(t.due).replace(/\(.\)$/, '') : (dueDays(t) || t.time || '終日');
  var strong = showDate || !!t.time || !!t.dueFirst;
  // どの行も同じ形にする。1行目は「動画名の作業」、2行目は「案件・投稿日」
  var isVideoWork = !!t.work && t.work !== 'その他';
  var title = (t.title || t.project) + (isVideoWork ? 'の' + t.work : '');
  var noVideo = !isVideoWork || t.project === '管理' || t.work === 'MTG'; // 動画を作らない行
  var post = t.postDate ? postLabel(t).replace(/投稿分$/, '投稿') : (noVideo ? '投稿なし' : '投稿日未定');
  var subParts = [t.project, post]; // 動画名が無い行も、形を揃えるため案件名を出す
  var middle = [fxText(title, { size: 'sm', weight: 'bold', color: FX.ink, wrap: true })];
  if (subParts.length) middle.push(fxText(subParts.join('・'), { size: 'xs', color: FX.sub, wrap: true }));
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'md',
    contents: [
      { type: 'box', layout: 'vertical', width: '44px', flex: 0,
        contents: [fxText(when, { size: 'sm', weight: strong ? 'bold' : 'regular', color: showDate ? FX.red : (strong ? FX.ink : FX.sub) })] },
      { type: 'box', layout: 'vertical', flex: 1, contents: middle },
      fxText(t.status, { size: 'xs', weight: 'bold', color: STATUS_COLORS[t.status] || FX.sub, flex: 0, align: 'end' })
    ]
  };
}

/** 毎朝の通知をカード形式で作る。urls は { page }。 */
function buildFlexMessage(tasks, today, urls) {
  urls = urls || {};
  var c = classify(tasks, today);
  var sections = [
    { title: '今日が期限', short: '今日', date: today, list: c.today, color: FX.ink },
    { title: '明日が期限', short: '明日', date: addDays(today, 1), list: c.tomorrow, color: FX.sub },
    { title: '明後日が期限', short: '明後日', date: addDays(today, 2), list: c.dayAfter, color: FX.sub }
  ]; // 3日分は、期限のものが無い日も「なし」と出して、見落としではないと分かるようにする

  var body = [], rows = 0, omitted = 0;
  sections.forEach(function (s, i) {
    if (i > 0) body.push({ type: 'separator', margin: 'xl', color: FX.line });
    body.push({
      type: 'box', layout: 'baseline', margin: i > 0 ? 'xl' : 'none', spacing: 'sm',
      contents: [
        fxText(s.title, { size: 'md', weight: 'bold', color: s.color, flex: 0 }),
        fxText(formatShort(s.date) + '　' + s.list.length + '件', { size: 'xs', color: FX.sub, flex: 0 })
      ]
    });
    if (!s.list.length) {
      body.push(fxText('なし', { size: 'sm', color: FX.sub, margin: 'md' }));
      return;
    }
    var groups = groupByOwner(s.list);
    groups.sort(function (a, b) { return (a.owner === ME ? 0 : 1) - (b.owner === ME ? 0 : 1); });
    groups.forEach(function (g) {
      body.push(fxText(g.owner + '　' + g.tasks.length + '件', { size: 'xs', weight: 'bold', color: FX.sub, margin: 'lg' }));
      g.tasks.forEach(function (t) {
        if (rows >= FLEX_MAX_ROWS) { omitted++; return; }
        rows++;
        body.push(fxRow(t, false));
      });
    });
  });

  var notes = [];
  if (omitted) notes.push('ほか' + omitted + '件はシートで確認');
  var unreadable = tasks.filter(function (t) { return t.dueUnreadable; });
  if (unreadable.length) notes.push('期限日を読めない行 ' + unreadable.map(function (t) { return t.row + '行目'; }).join('、'));
  if (notes.length) {
    body.push({ type: 'separator', margin: 'xl', color: FX.line });
    body.push(fxText(notes.join('　／　'), { size: 'xs', color: FX.sub, wrap: true, margin: 'lg' }));
  }

  var bubble = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: FX.ink, paddingAll: '16px',
      contents: [
        fxText('制作の期限', { size: 'xs', color: '#B8C0CC' }),
        fxText(formatShort(today), { size: 'xl', weight: 'bold', color: '#FFFFFF' })
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: body }
  };
  var buttons = [];
  if (/^https:\/\//.test(urls.page || '')) {
    buttons.push({ type: 'button', style: 'primary', color: FX.ink, height: 'sm',
      action: { type: 'uri', label: '一覧ページを開く', uri: urls.page } });
  }
  if (buttons.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: buttons };

  // 通知とトーク一覧に出る1行
  var counts = sections.map(function (s) { return s.short + s.list.length + '件'; });
  var alt = '制作の期限 ' + formatShort(today) + '：' + counts.join('・');
  return { type: 'flex', altText: alt.slice(0, 400), contents: bubble };
}

/* ---------- 送信先の一覧 ---------- */

/** LINE_TO の値（カンマ区切り）を、送信先IDの配列にする。形の違うものと重複は除く。 */
function parseDestinations(value) {
  var seen = {}, out = [];
  String(value == null ? '' : value).split(/[,、\s]+/).forEach(function (id) {
    if (/^[UCR][0-9a-f]{32}$/.test(id) && !seen[id]) { seen[id] = true; out.push(id); }
  });
  return out;
}

/** 送信先を1つ足した LINE_TO の値を返す。すでに入っていれば元のまま。 */
function addDestination(value, id) {
  var list = parseDestinations(value);
  if (list.indexOf(id) === -1) list.push(id);
  return list.join(',');
}

/** LINE_TO の値から、指定したIDを除いた値を返す。 */
function removeDestinations(value, ids) {
  return parseDestinations(value).filter(function (d) { return ids.indexOf(d) === -1; }).join(',');
}

/* ---------- LINEで送るコマンド ---------- */

// 普段の会話で偶然一致しないよう、先頭に「/」を付けた英語にしている
var COMMANDS = {
  '/rm off': 'pause', '/rm on': 'resume', '/status': 'list', '/help': 'help'
};

/**
 * Webhookの本文から、コマンドとして送られた発言を取り出す。
 * 発言全体がコマンドと一致したときだけ反応する（普段の会話では反応しない）。
 * 戻り値は [{ command, replyToken, source }]。
 */
function extractCommands(bodyText) {
  var body;
  try { body = JSON.parse(bodyText); } catch (err) { return []; }
  var out = [];
  ((body && body.events) || []).forEach(function (e) {
    if (!e || e.type !== 'message' || !e.message || e.message.type !== 'text' || !e.replyToken) return;
    // 全角の「／」や空白のゆれ、大文字小文字は同じものとして扱う
    var text = String(e.message.text).replace(/／/g, '/').replace(/[\s　]+/g, ' ').trim().toLowerCase();
    var cmd = COMMANDS[text];
    if (!cmd) return;
    var src = e.source || {};
    out.push({ command: cmd, replyToken: e.replyToken, source: src.groupId || src.roomId || src.userId || '' });
  });
  return out;
}

/* ---------- 発言の記録 ---------- */

/**
 * Webhookの本文から、記録する発言を取り出す。
 * 戻り値は [{ time, chatId, userId, kind, text }]。time は送信時刻（ミリ秒）。
 */
function extractLogEntries(bodyText) {
  var body;
  try { body = JSON.parse(bodyText); } catch (err) { return []; }
  var LABELS = { image: '［画像］', video: '［動画］', audio: '［音声］', file: '［ファイル］', sticker: '［スタンプ］', location: '［位置情報］' };
  var out = [];
  ((body && body.events) || []).forEach(function (e) {
    if (!e || e.type !== 'message' || !e.message) return;
    var src = e.source || {};
    var m = e.message;
    var text = m.type === 'text' ? String(m.text) : (LABELS[m.type] || '［' + m.type + '］') + (m.fileName ? ' ' + m.fileName : '');
    out.push({ time: Number(e.timestamp) || 0, chatId: src.groupId || src.roomId || src.userId || '', userId: src.userId || '', kind: m.type, text: text });
  });
  return out;
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
  var body = e && e.postData ? e.postData.contents : '';
  var id = extractGroupId(body);
  if (id) PropertiesService.getScriptProperties().setProperty('LINE_GROUP_ID', id);
  try { logMessages_(body); } catch (err) { /* 記録に失敗しても返事やコマンドは止めない */ }
  extractCommands(body).forEach(function (c) {
    var text;
    try { text = runCommand_(c); } catch (err) { text = 'うまく処理できませんでした：' + err.message; }
    if (text) replyLine_(c.replyToken, text);
  });
  return ContentService.createTextOutput('ok');
}

/** 受け取った発言を「LINEログ」タブに1行ずつ書き残す。送信先か一時停止中のトークの発言だけ。 */
function logMessages_(body) {
  var entries = extractLogEntries(body);
  if (!entries.length) return;
  var props = PropertiesService.getScriptProperties();
  var known = parseDestinations(props.getProperty('LINE_TO')).concat(parseDestinations(props.getProperty('LINE_TO_PAUSED')));
  entries = entries.filter(function (e) { return known.indexOf(e.chatId) !== -1; });
  if (!entries.length) return;
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['日時', 'トーク', '送信者', '種類', '内容']);
    sheet.setFrozenRows(1);
  }
  var rows = entries.map(function (e) {
    return [Utilities.formatDate(new Date(e.time || Date.now()), TZ, 'yyyy/MM/dd HH:mm:ss'),
      cachedName_('chat:' + e.chatId, function () { return destinationName_(e.chatId); }),
      e.userId ? cachedName_('user:' + e.chatId + ':' + e.userId, function () { return memberName_(e.chatId, e.userId); }) : '',
      e.kind, e.text];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** 名前の取得結果を6時間おぼえておき、LINEへの問い合わせを減らす。 */
function cachedName_(key, fetch) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return hit;
  var name = fetch() || '';
  if (name) cache.put(key, name, 21600);
  return name;
}

/** グループのメンバーの表示名。取れなければ ''。 */
function memberName_(chatId, userId) {
  var kind = chatId.charAt(0);
  var url = kind === 'C' ? 'https://api.line.me/v2/bot/group/' + chatId + '/member/' + userId
          : kind === 'R' ? 'https://api.line.me/v2/bot/room/' + chatId + '/member/' + userId
          : 'https://api.line.me/v2/bot/profile/' + userId;
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + lineToken_() }, muteHttpExceptions: true });
  return res.getResponseCode() === 200 ? (JSON.parse(res.getContentText()).displayName || '') : '';
}

/** 送信先か一時停止中のグループから来たコマンドだけを処理し、返信の文を返す。 */
function runCommand_(c) {
  var props = PropertiesService.getScriptProperties();
  var known = parseDestinations(props.getProperty('LINE_TO')).concat(parseDestinations(props.getProperty('LINE_TO_PAUSED')));
  if (known.indexOf(c.source) === -1) return ''; // 登録していないトークからは受け付けない
  if (c.command === 'pause') return pauseRM_().message;
  if (c.command === 'resume') return resumeRM_().message;
  if (c.command === 'list') return destinationsText_();
  return ['使えるコマンド（この文だけを1通で送ってください）',
    '/rm off：RMのグループへの毎朝の通知を止める',
    '/rm on：止めた通知を再開する',
    '/status：いま通知が届くグループを表示する',
    '/help：この一覧を表示する'].join('\n');
}

/** LINEの返信（受け取った発言への返事。送信数の上限には数えられない）。 */
function replyLine_(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineToken_() },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function latestGroupId_() {
  var id = PropertiesService.getScriptProperties().getProperty('LINE_GROUP_ID');
  if (!id) throw new Error('グループIDをまだ受け取っていません。botをグループに招待し、グループで何か1通送ってから実行してください。');
  return id;
}

/** 最後に受け取ったグループだけを送信先にして、確認の1通を送る（ほかの送信先は外れる）。 */
function useGroup() {
  var id = latestGroupId_();
  PropertiesService.getScriptProperties().setProperty('LINE_TO', id);
  pushLine_('このグループに、毎朝の制作期限を送ります。', id);
}

/** 最後に受け取ったグループを送信先に追加して、そのグループに確認の1通を送る。 */
function addGroup() {
  var props = PropertiesService.getScriptProperties();
  var id = latestGroupId_();
  var before = parseDestinations(props.getProperty('LINE_TO'));
  if (before.indexOf(id) !== -1) {
    throw new Error('このグループはすでに送信先に入っています。新しいグループで1通送ってから、もう一度実行してください。');
  }
  props.setProperty('LINE_TO', addDestination(props.getProperty('LINE_TO'), id));
  pushLine_('このグループにも、毎朝の制作期限を送ります。', id);
  Logger.log('送信先は' + (before.length + 1) + 'か所になりました。');
}

/* ---------- 送信先の確認と一時停止 ---------- */

var RM_KEYWORD = 'Robin Marketing'; // このグループ名を含む送信先を pauseRM / resumeRM の対象にする

/** 送信先のIDから、LINE上の名前を取る。取れなければ種類だけ返す。 */
function destinationName_(id) {
  var kind = id.charAt(0);
  var url = kind === 'C' ? 'https://api.line.me/v2/bot/group/' + id + '/summary'
          : kind === 'U' ? 'https://api.line.me/v2/bot/profile/' + id : '';
  if (url) {
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + lineToken_() }, muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var j = JSON.parse(res.getContentText());
      return j.groupName || j.displayName || '';
    }
  }
  return ({ U: '個人', C: 'グループ', R: '複数人トーク' })[kind] + '（名前を取得できません）';
}

/** 送信先と一時停止中の送信先を、名前つきの文にする。 */
function destinationsText_() {
  var props = PropertiesService.getScriptProperties();
  var on = parseDestinations(props.getProperty('LINE_TO'));
  var off = parseDestinations(props.getProperty('LINE_TO_PAUSED'));
  var lines = ['送信中：' + on.length + 'か所'];
  on.forEach(function (id, i) { lines.push('  ' + (i + 1) + '. ' + destinationName_(id)); });
  lines.push('一時停止中：' + off.length + 'か所');
  off.forEach(function (id, i) { lines.push('  ' + (i + 1) + '. ' + destinationName_(id)); });
  return lines.join('\n');
}

/** 送信先と一時停止中の送信先を、名前つきでログに出す。 */
function listDestinations() {
  show_('送信先', destinationsText_());
}

/** グループ名に RM_KEYWORD を含む送信先を、一時停止に移す。結果を { ok, message } で返す。 */
function pauseRM_() {
  var props = PropertiesService.getScriptProperties();
  var on = parseDestinations(props.getProperty('LINE_TO'));
  var hit = on.filter(function (id) { return destinationName_(id).indexOf(RM_KEYWORD) !== -1; });
  if (!hit.length) {
    var off = parseDestinations(props.getProperty('LINE_TO_PAUSED'));
    var already = off.some(function (id) { return destinationName_(id).indexOf(RM_KEYWORD) !== -1; });
    return { ok: false, message: already ? 'RMへの通知は、すでに止まっています。' : '送信先に「' + RM_KEYWORD + '」を含むグループがありません。\n\n' + destinationsText_() };
  }
  if (hit.length === on.length) return { ok: false, message: '止めると送信先が0か所になるため、止めませんでした。' };
  props.setProperty('LINE_TO', removeDestinations(props.getProperty('LINE_TO'), hit));
  var paused = props.getProperty('LINE_TO_PAUSED');
  hit.forEach(function (id) { paused = addDestination(paused, id); });
  props.setProperty('LINE_TO_PAUSED', paused);
  return { ok: true, message: 'RMへの毎朝の通知を止めました。再開するときは「/rm on」と送ってください。\n\n' + destinationsText_() };
}

/** pauseRM で止めた送信先を、送信先に戻す。結果を { ok, message } で返す。 */
function resumeRM_() {
  var props = PropertiesService.getScriptProperties();
  var off = parseDestinations(props.getProperty('LINE_TO_PAUSED'));
  var hit = off.filter(function (id) { return destinationName_(id).indexOf(RM_KEYWORD) !== -1; });
  if (!hit.length) return { ok: false, message: 'RMへの通知は止まっていません。\n\n' + destinationsText_() };
  var to = props.getProperty('LINE_TO');
  hit.forEach(function (id) { to = addDestination(to, id); });
  props.setProperty('LINE_TO', to);
  props.setProperty('LINE_TO_PAUSED', removeDestinations(props.getProperty('LINE_TO_PAUSED'), hit));
  return { ok: true, message: 'RMへの毎朝の通知を再開しました。明日の朝から届きます。\n\n' + destinationsText_() };
}

/** Apps Scriptの画面から実行する用。 */
function pauseRM() {
  var r = pauseRM_();
  Logger.log(r.message);
  if (!r.ok) throw new Error(r.message.split('\n')[0]);
}

function resumeRM() {
  var r = resumeRM_();
  Logger.log(r.message);
  if (!r.ok) throw new Error(r.message.split('\n')[0]);
}

function todayString_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function readTasks_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('「' + SHEET_NAME + '」という名前のシートがありません。');
  return parseRows(sheet.getDataRange().getDisplayValues(), todayString_());
}

function lineToken_() {
  // 貼り付け時に紛れた空白・改行・先頭の「Bearer 」を取り除く
  var token = String(PropertiesService.getScriptProperties().getProperty('LINE_TOKEN') || '')
    .replace(/\s+/g, '').replace(/^Bearer/i, '');
  if (!token) throw new Error('スクリプト プロパティに LINE_TOKEN を設定してください。');
  return token;
}

function destinations_() {
  var list = parseDestinations(PropertiesService.getScriptProperties().getProperty('LINE_TO'));
  if (!list.length) throw new Error('スクリプト プロパティの LINE_TO に送信先がありません。');
  return list;
}

/** 1つの送信先へメッセージの配列を送り、HTTPの応答を返す。 */
function pushTo_(to, messages) {
  return UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineToken_() },
    payload: JSON.stringify({ to: to, messages: messages }),
    muteHttpExceptions: true
  });
}

/** 文字だけのメッセージを送る。to を省くと、登録済みの送信先すべてに送る。 */
function pushLine_(text, to) {
  (to ? [to] : destinations_()).forEach(function (dest) {
    var res = pushTo_(dest, [{ type: 'text', text: text }]);
    var code = res.getResponseCode();
    if (code !== 200) throw new Error('LINEへの送信に失敗しました（' + code + '）：' + res.getContentText());
  });
}

/**
 * 設定の点検。値そのものは表示せず、長さと形、LINEに通るかどうかだけをログに出す。
 */
function checkSettings() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Logger.log('登録されているプロパティ名: ' + Object.keys(props).map(function (k) { return '「' + k + '」'; }).join(' '));
  var rawToken = String(props.LINE_TOKEN || '');
  var token = rawToken.replace(/\s+/g, '').replace(/^Bearer/i, '');
  var dests = parseDestinations(props.LINE_TO);
  Logger.log('LINE_TOKEN: ' + rawToken.length + '文字（空白などを除くと' + token.length + '文字）。' +
    (token.length === 32 ? '32文字はChannel secretの長さです。' :
     token.length === 33 && /^[UCR]/.test(token) ? 'ユーザーIDの形です。LINE_TOと入れ違いの可能性があります。' :
     token.length < 100 ? '長期トークンは170文字前後なので短すぎます。' : '長さは長期トークンとして妥当です。'));
  Logger.log('LINE_TO: 送信先' + dests.length + 'か所' +
    (dests.length ? '（' + dests.map(function (d) { return ({ U: '個人', C: 'グループ', R: '複数人トーク' })[d.charAt(0)]; }).join('、') + '）。' :
     '。U・C・Rのどれかで始まる33文字のIDが入っていません。'));
  if (!token) return;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  if (res.getResponseCode() === 200) {
    var info = JSON.parse(res.getContentText());
    Logger.log('トークンは有効です。アカウント: ' + info.displayName + '（' + info.basicId + '）');
  } else {
    Logger.log('トークンは無効です（' + res.getResponseCode() + '）: ' + res.getContentText());
  }
}

/**
 * LINEに何も送らずに、仕組みが動くかを点検してログに出す。
 * 1. トークン  2. 送信先  3. 毎朝の予約  4. Webhook  5. デプロイ済みの版  6. 今日のカード  7. コマンドの読み取り
 */
function selfCheck() {
  var props = PropertiesService.getScriptProperties();
  var results = [];
  function add(ok, label, detail) { results.push((ok ? 'OK　' : 'NG　') + label + (detail ? '：' + detail : '')); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { Authorization: 'Bearer ' + lineToken_() };
    opts.muteHttpExceptions = true;
    return UrlFetchApp.fetch('https://api.line.me' + path, opts);
  }

  // 1. トークン
  var info = api('/v2/bot/info');
  add(info.getResponseCode() === 200, 'トークン',
    info.getResponseCode() === 200 ? JSON.parse(info.getContentText()).displayName : '無効（' + info.getResponseCode() + '）');

  // 2. 送信先
  var on = parseDestinations(props.getProperty('LINE_TO'));
  add(on.length > 0, '送信先', on.length ? on.map(destinationName_).join('、') : 'LINE_TO が空です');
  var off = parseDestinations(props.getProperty('LINE_TO_PAUSED'));
  if (off.length) results.push('　　一時停止中：' + off.map(destinationName_).join('、'));

  // 3. 毎朝の予約
  var all = ScriptApp.getProjectTriggers();
  var plan = all.filter(function (t) { return t.getHandlerFunction() === 'planExactSend'; });
  var old = all.filter(function (t) { return t.getHandlerFunction() === 'sendMorningDigest'; });
  add(plan.length === 1 && !old.length, '毎朝の予約',
    plan.length === 1 && !old.length ? '毎朝' + SEND_HOUR + ':00ちょうど' :
    '古い形か重複しています。メニューの「毎朝' + SEND_HOUR + '時の通知を登録する」を押してください');

  // 4. Webhook（LINEがグループの発言をこのスクリプトに渡すか）
  var appUrl = ScriptApp.getService().getUrl() || '';
  var wh = api('/v2/bot/channel/webhook/endpoint');
  if (wh.getResponseCode() === 200) {
    var w = JSON.parse(wh.getContentText());
    add(w.active, 'Webhookの利用', w.active ? 'オン' : 'オフ（LINE Developersコンソールでオンにしてください）');
    var same = String(w.endpoint || '').replace(/\?.*$/, '') === appUrl.replace(/\?.*$/, '');
    add(same, 'Webhook URL', same ? 'このスクリプトの公開URLと一致' : 'このスクリプトの公開URLと違います（' + (w.endpoint || '未設定') + '）');
  } else {
    add(false, 'Webhook', '確認できませんでした（' + wh.getResponseCode() + '）');
  }

  // 5. デプロイ済みの版（LINEから呼ばれるのはデプロイした版）
  if (appUrl) {
    var v = UrlFetchApp.fetch(appUrl + '?check=version', { muteHttpExceptions: true, followRedirects: true });
    var deployed = v.getResponseCode() === 200 ? v.getContentText().trim() : '';
    add(deployed === CODE_VERSION, 'デプロイ済みの版',
      deployed === CODE_VERSION ? CODE_VERSION :
      (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(deployed) ? '古い版です（' + deployed + '）。' :
       deployed ? '古い版です（版の情報が入っていない頃のコード）。' : '確かめられませんでした。') +
      '「デプロイを管理」から新バージョンでデプロイしてください');
  } else {
    add(false, 'デプロイ', 'ウェブアプリとしてデプロイされていません');
  }

  // 6. 今日のカード（LINEの検査用の窓口に出すだけで、送信はしない）
  var tasks = readTasks_(), today = todayString_();
  var flex = buildFlexMessage(tasks, today, { page: props.getProperty('PAGE_URL') || '' });
  var val = api('/v2/bot/message/validate/push', { method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ messages: [flex] }) });
  add(val.getResponseCode() === 200, '今日のカード', val.getResponseCode() === 200 ? flex.altText : 'LINEが受け付けない形です：' + val.getContentText());

  // 7. コマンドの読み取り
  var sample = JSON.stringify({ events: [{ type: 'message', replyToken: 'x', source: { type: 'group', groupId: 'C' + Array(33).join('0') },
    message: { type: 'text', text: '/rm on' } }] });
  var cmd = extractCommands(sample);
  add(cmd.length === 1 && cmd[0].command === 'resume', 'コマンドの読み取り', '「/rm on」を再開として読めるか');

  results.push('', '今日のカードを文字にしたもの（送信はしていません）', buildMorningMessage(tasks, today, ''));
  show_('点検の結果（LINEには送っていません）', results.join('\n'));
}

/** メニューから実行したときは画面に出す。エディタから実行したときは実行ログに出す。 */
function show_(title, text) {
  Logger.log(text);
  try { SpreadsheetApp.getUi().alert(title, text, SpreadsheetApp.getUi().ButtonSet.OK); } catch (err) {}
}

/** 毎朝のトリガーから呼ばれる。手動で実行すると、その場で1通送る。 */
function sendMorningDigest() {
  var pageUrl = PropertiesService.getScriptProperties().getProperty('PAGE_URL') || '';
  var tasks = readTasks_(), today = todayString_();
  var flex = buildFlexMessage(tasks, today, { page: pageUrl });
  var errors = [];
  destinations_().forEach(function (to, i) {
    var res = pushTo_(to, [flex]);
    if (res.getResponseCode() === 200) return;
    // カード形式が通らなかった送信先には、理由をログに残して文字だけの通知を送る
    Logger.log((i + 1) + 'か所目：カード形式で送れませんでした（' + res.getResponseCode() + '）：' + res.getContentText());
    try { pushLine_(buildMorningMessage(tasks, today, pageUrl), to); }
    catch (err) { errors.push((i + 1) + 'か所目：' + err.message); }
  });
  if (errors.length) throw new Error(errors.join('\n'));
}

var DIGEST_HANDLERS = ['sendMorningDigest', 'planExactSend', 'sendAtExactTime'];

function deleteTriggers_(names) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (names.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

/**
 * 毎朝の通知を登録する。何度実行しても通知は1日1回のまま。
 * 毎日の予約は「何時台」までしか指定できないため、SEND_HOUR の1時間前に planExactSend を動かし、
 * その日の SEND_HOUR:00:00 ちょうどに1回だけ動く予約（sendAtExactTime）を作る。
 */
function setup() {
  deleteTriggers_(DIGEST_HANDLERS);
  ScriptApp.newTrigger('planExactSend')
    .timeBased().everyDays(1).atHour(SEND_HOUR - 1).inTimezone(TZ).create();
  planExactSend();
}

/** 今日の SEND_HOUR:00:00 に1回だけ送る予約を作る。その時刻を過ぎていたら作らない。 */
function planExactSend() {
  deleteTriggers_(['sendAtExactTime']);
  var day = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var at = new Date(day + 'T' + (SEND_HOUR < 10 ? '0' : '') + SEND_HOUR + ':00:00+09:00');
  if (at.getTime() > Date.now()) ScriptApp.newTrigger('sendAtExactTime').timeBased().at(at).create();
}

/** planExactSend が作った予約から呼ばれる。使い終わった予約を消してから送る。 */
function sendAtExactTime() {
  deleteTriggers_(['sendAtExactTime']);
  sendMorningDigest();
}

/** 毎朝の通知を止める。 */
function stopDigest() {
  deleteTriggers_(DIGEST_HANDLERS);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('制作管理')
    .addItem('LINEに送らずに点検する', 'selfCheck')
    .addItem('今すぐLINEに送る', 'sendMorningDigest')
    .addItem('毎朝' + SEND_HOUR + '時の通知を登録する', 'setup')
    .addItem('毎朝の通知を止める', 'stopDigest')
    .addItem('送信先をグループに切り替える', 'useGroup')
    .addItem('送信先にグループを追加する', 'addGroup')
    .addItem('送信先を確認する', 'listDestinations')
    .addItem('RMへの送信を止める', 'pauseRM')
    .addItem('RMへの送信を再開する', 'resumeRM')
    .addToUi();
}

/* ---------- 閲覧ページ ---------- */

function doGet(e) {
  // selfCheck から、デプロイ済みの版を確かめるために呼ばれる
  if (e && e.parameter && e.parameter.check === 'version') return ContentService.createTextOutput(CODE_VERSION);
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ROBIN 制作管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 閲覧ページから呼ばれる。 */
function getData() {
  var today = todayString_(), tomorrow = addDays(today, 1);
  var pageUrl = PropertiesService.getScriptProperties().getProperty('PAGE_URL') || '';
  var tasks = readTasks_();
  return {
    today: today,
    loadedAt: Utilities.formatDate(new Date(), TZ, 'M/d HH:mm'),
    sheetUrl: SpreadsheetApp.getActive().getUrl(),
    tasks: tasks,
    // LINEに届く通知と同じ中身。今朝の分と、いまのシートのままなら明日の朝に届く分
    preview: {
      today: buildFlexMessage(tasks, today, { page: pageUrl }),
      tomorrow: buildFlexMessage(parseRows(SpreadsheetApp.getActive().getSheetByName(SHEET_NAME).getDataRange().getDisplayValues(), tomorrow), tomorrow, { page: pageUrl }),
      sendHour: SEND_HOUR
    }
  };
}

// テスト用（Apps Script上では何もしない）
if (typeof module !== 'undefined') {
  module.exports = {
    normalizeDate: normalizeDate, normalizeTime: normalizeTime, addDays: addDays,
    formatShort: formatShort, parseRows: parseRows, classify: classify,
    buildMorningMessage: buildMorningMessage, buildFlexMessage: buildFlexMessage,
    extractGroupId: extractGroupId, parseDestinations: parseDestinations, addDestination: addDestination,
    removeDestinations: removeDestinations, extractCommands: extractCommands, extractLogEntries: extractLogEntries
  };
}
