'use strict';
/*
  خادم الاختبار المباشر (بأسلوب Kahoot) – بدون أي مكتبات خارجية.
  التشغيل:   node server.js            (يتطلب Node 18 أو أحدث)
  رمز المعلمة: TEACHER_PIN=1234 node server.js   (وإلا يُولَّد رمز عشوائي ويظهر في الشاشة)
*/
const http = require('http'), fs = require('fs'), path = require('path');
const os = require('os'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const PIN = process.env.TEACHER_PIN || String(crypto.randomInt(1000, 10000));
const MAX_PLAYERS = 20;       // أقصى عدد للطلاب
const Q_TIME = 30000;         // 30 ثانية لكل سؤال
const READY_TIME = 3000;      // عدّ تنازلي قبل السؤال الأول
const GRACE = 600;            // سماح بسيط لتأخر الشبكة (ms)
const DB_URL = "https://test10markscir-default-rtdb.firebaseio.com";
const BOARD = "scores_arabic_live";

// answer = رقم الإجابة الصحيحة (0 = الأولى). الإجابات تبقى هنا في الخادم ولا تصل للطلاب قبل انتهاء السؤال.
const BANK = [
  { q: "من كاتب قصة «مفتش المدارس»؟",
    options: ["م. آثار طاهر", "نجيب محفوظ", "غسان كنفاني", "توفيق الحكيم"], answer: 0 },
  { q: "عمّ كان المفتش يبحث في القرية؟",
    options: ["عن فلاح ضائع", "عن المدرسة", "عن نجّار ماهر", "عن أرض للبيع"], answer: 1 },
  { q: "كم سنة قضى المفتش في البحث عن المدارس عبر القطاعات؟",
    options: ["سنة واحدة", "ثلاث سنوات", "عشر سنوات", "خمس سنوات"], answer: 1 },
  { q: "بماذا شعر القروي حين طلب منه المفتش أن يدلّه على المدرسة؟",
    options: ["بالخوف", "بالغضب", "بالملل", "بالفخر والزهو"], answer: 3 },
  { q: "ماذا قصد الفلاح بقوله: «إن المعلّم ينقلها معه»؟",
    options: ["أن المدرسة ليس لها مبنى ثابت", "أن المعلم يحمل الكتب في سيارته", "أن المدرسة بُنيت في مدينة أخرى", "أن المعلم يملك عدة مدارس"], answer: 0 },
  { q: "أين وجد المفتش المدرسة في النهاية؟",
    options: ["في مبنى كبير وسط القرية", "في العراء وسط حقل القصب", "داخل بيت الزعيم", "في المدينة"], answer: 1 },
  { q: "كم طالباً وجد المفتش جالسين على الأرض الجرداء؟",
    options: ["عشرين طالباً", "ثلاثين طالباً", "أربعين طالباً", "ستين طالباً"], answer: 2 },
  { q: "لماذا ارتبك الطالب حين طلب منه المفتش أن يقرأ؟",
    options: ["لأنه كان مريضاً", "لأنه كان متعباً من العمل في الحقل", "لأنه خاف من الزعيم", "لأن الكتاب لصف أعلى من صفه"], answer: 3 },
  { q: "كم فصلاً دراسياً يدرّسه المعلم في مدرسته؟",
    options: ["فصلين", "ستة فصول", "أربعة فصول", "عشرة فصول"], answer: 1 },
  { q: "ما الفكرة الرئيسة للقصة؟",
    options: ["جمال الحياة في الريف", "أهمية شراء سيارة حديثة للمفتش", "إصرار المعلم على تعليم الأطفال رغم انعدام الإمكانات", "صعوبة زراعة القصب"], answer: 2 }
];
// الأسئلة الستة المستخدمة (أرقامها من القائمة أعلاه تبدأ من 0). غيّرها كما تريدين.
const PICK = [1, 2, 4, 5, 6, 9];
const QUESTIONS = PICK.map(i => BANK[i]);

/* ---------------- الحالة ---------------- */
function newGame() {
  return { phase: 'lobby', players: new Map(), qi: -1, qStart: 0, endsAt: 0, timer: null, dist: null };
}
let game = newGame();
const clients = new Set();     // اتصالات SSE: {res, role, id|token}
const tokens = new Set();      // رموز المعلمة الصالحة
const fails = new Map();       // محاولات الدخول الفاشلة لكل IP

const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ranked = () => [...game.players.values()].sort((a, b) => b.score - a.score || b.correct - a.correct || a.joined - b.joined);
const answeredCount = () => [...game.players.values()].filter(p => p.choice !== null).length;

/* ---------------- ما يراه كل طرف ---------------- */
function studentView(p) {
  const list = ranked();
  const v = {
    role: 'student', phase: game.phase, serverNow: Date.now(), max: MAX_PLAYERS, total: QUESTIONS.length,
    qTime: Q_TIME, count: game.players.size, endsAt: game.endsAt, qIndex: game.qi,
    you: { name: p.name, score: p.score, correct: p.correct, rank: list.indexOf(p) + 1, choice: p.choice, gained: p.gained }
  };
  if (game.phase === 'lobby') v.names = [...game.players.values()].map(x => x.name);
  if (game.phase === 'question' || game.phase === 'reveal') {
    const q = QUESTIONS[game.qi];
    v.question = { text: q.q, options: p.order.map(oi => q.options[oi]) };
    if (game.phase === 'reveal') {
      v.reveal = { correctPos: p.order.indexOf(q.answer) };
      v.top = list.slice(0, 5).map(x => ({ name: x.name, score: x.score }));
    }
  }
  if (game.phase === 'finished') v.board = list.map(x => ({ name: x.name, score: x.score, correct: x.correct }));
  return v;
}

function teacherView() {
  const list = ranked();
  const v = {
    role: 'teacher', phase: game.phase, serverNow: Date.now(), max: MAX_PLAYERS, total: QUESTIONS.length,
    qTime: Q_TIME, count: game.players.size, endsAt: game.endsAt, qIndex: game.qi,
    players: [...game.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, answered: p.choice !== null })),
    answered: answeredCount(), urls: lanUrls()
  };
  if (game.phase === 'question' || game.phase === 'reveal') {
    const q = QUESTIONS[game.qi];
    v.question = { text: q.q, options: q.options };
    if (game.phase === 'reveal') {
      v.reveal = { correct: q.answer, dist: game.dist };
      v.top = list.slice(0, 5).map(x => ({ name: x.name, score: x.score }));
    }
  }
  if (game.phase === 'finished') v.board = list.map(x => ({ name: x.name, score: x.score, correct: x.correct }));
  return v;
}

function send(c, obj) { try { c.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { clients.delete(c); } }
function sendView(c) {
  if (c.role === 'teacher') return tokens.has(c.token) ? send(c, teacherView()) : kick(c);
  const p = game.players.get(c.id);
  return p ? send(c, studentView(p)) : kick(c);
}
function kick(c) { send(c, { kicked: true, serverNow: Date.now() }); try { c.res.end(); } catch (e) {} clients.delete(c); }
function broadcast(onlyTeacher) { for (const c of [...clients]) if (!onlyTeacher || c.role === 'teacher') sendView(c); }

/* ---------------- سير الاختبار ---------------- */
function startReady() {
  game.phase = 'ready'; game.endsAt = Date.now() + READY_TIME;
  game.timer = setTimeout(() => startQuestion(0), READY_TIME);
  broadcast();
}
function startQuestion(i) {
  clearTimeout(game.timer);
  game.qi = i; game.phase = 'question'; game.qStart = Date.now(); game.endsAt = game.qStart + Q_TIME; game.dist = null;
  const n = QUESTIONS[i].options.length;
  for (const p of game.players.values()) { p.choice = null; p.gained = 0; p.order = shuffle([...Array(n).keys()]); }
  game.timer = setTimeout(endQuestion, Q_TIME + GRACE);
  broadcast();
}
function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  const q = QUESTIONS[game.qi], dist = q.options.map(() => 0);
  for (const p of game.players.values()) if (p.choice !== null) dist[p.order[p.choice]]++;
  game.dist = dist; game.phase = 'reveal'; game.endsAt = 0;
  broadcast();
}
function finish() {
  game.phase = 'finished'; game.endsAt = 0;
  broadcast();
  saveBoard();
}
async function saveBoard() {
  for (const p of game.players.values()) {
    try {
      await fetch(`${DB_URL}/${BOARD}.json`, { method: 'POST',
        body: JSON.stringify({ name: p.name, score: p.score, correct: p.correct, total: QUESTIONS.length, time: Date.now() }) });
    } catch (e) {}
  }
}

/* ---------------- واجهة API ---------------- */
function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40); }
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function api(path_, b, ip) {
  switch (path_) {
    case '/api/join': {
      if (game.phase !== 'lobby') return { error: 'بدأ الاختبار بالفعل ولا يمكن الانضمام الآن.' };
      if (game.players.size >= MAX_PLAYERS) return { error: `اكتمل العدد (${MAX_PLAYERS} طالباً).` };
      const name = cleanName(b.name);
      if (name.length < 2) return { error: 'اكتب اسمك الكامل.' };
      for (const p of game.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return { error: 'هذا الاسم مستخدم، أضف حرفاً أو اسم العائلة.' };
      const id = crypto.randomBytes(12).toString('hex');
      game.players.set(id, { id, name, score: 0, correct: 0, choice: null, gained: 0, order: [], joined: Date.now() });
      broadcast();
      return { id };
    }
    case '/api/answer': {
      const p = game.players.get(b.id), now = Date.now();
      if (!p || game.phase !== 'question' || p.choice !== null || now > game.endsAt + GRACE) return { error: 'closed' };
      const pos = b.pos;
      if (!Number.isInteger(pos) || pos < 0 || pos >= p.order.length) return { error: 'bad' };
      const elapsed = Math.min(Math.max(now - game.qStart, 0), Q_TIME);
      p.choice = pos;
      if (p.order[pos] === QUESTIONS[game.qi].answer) {
        // مثل Kahoot: 1000 نقطة للإجابة الفورية وتنزل تدريجياً إلى 500 عند آخر ثانية
        p.gained = Math.round(1000 * (1 - (elapsed / Q_TIME) / 2));
        p.score += p.gained; p.correct++;
      }
      if (answeredCount() === game.players.size) endQuestion();
      else { broadcast(true); for (const c of clients) if (c.id === p.id) sendView(c); }
      return { ok: true };
    }
    case '/api/teacher/login': {
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (Date.now() < f.until) return { error: 'محاولات كثيرة، انتظري دقيقة.' };
      if (!safeEq(b.pin, PIN)) {
        f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; } fails.set(ip, f);
        return { error: 'رمز غير صحيح.' };
      }
      fails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex'); tokens.add(token);
      return { token };
    }
    case '/api/teacher/action': {
      // كل أوامر التحكم تمرّ من هنا ولا تعمل إلا برمز المعلمة
      if (!tokens.has(b.token)) return { error: 'غير مصرّح.' };
      switch (b.action) {
        case 'go':
          if (game.phase !== 'lobby' || game.players.size < 1) return { error: 'لا يمكن البدء الآن.' };
          startReady(); break;
        case 'skip': endQuestion(); break;
        case 'next':
          if (game.phase !== 'reveal') return { error: 'غير متاح الآن.' };
          game.qi + 1 < QUESTIONS.length ? startQuestion(game.qi + 1) : finish(); break;
        case 'kick':
          if (game.phase !== 'lobby') return { error: 'متاح في غرفة الانتظار فقط.' };
          game.players.delete(b.id); broadcast(); break;
        case 'reset':
          clearTimeout(game.timer); game = newGame(); broadcast(); break;
        default: return { error: 'أمر غير معروف.' };
      }
      return { ok: true };
    }
  }
  return { error: 'not found' };
}

/* ---------------- الخادم ---------------- */
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out.length ? out : [`http://localhost:${PORT}`];
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 10000) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && ['/', '/teacher', '/teacher/'].includes(u.pathname)) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) { res.writeHead(500); return res.end('index.html not found'); }
  }
  if (req.method === 'GET' && u.pathname === '/api/events') {
    const token = u.searchParams.get('token'), id = u.searchParams.get('id');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const c = token ? { res, role: 'teacher', token } : { res, role: 'student', id };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return sendView(c);
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    const body = await readBody(req);
    const out = api(u.pathname, body, req.socket.remoteAddress);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out));
  }
  res.writeHead(404); res.end('Not found');
});

setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== اختبار مباشر – مفتش المدارس ===');
  lanUrls().forEach(u => { console.log('الطلاب  :', u); console.log('المعلمة :', u + '/teacher'); });
  console.log('رمز المعلمة (PIN):', PIN, '\n');
});
