const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { readDb, mutateDb } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const sessions = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

function nowMs() { return Date.now(); }
function createId(prefix) { return `${prefix}-${crypto.randomBytes(6).toString('hex')}`; }
function createToken() { return crypto.randomBytes(32).toString('hex'); }
function normalize(value) { return String(value ?? '').trim(); }
function normalizeKey(value) { return normalize(value).toLowerCase(); }
function parseStartTime(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}
function getSession(req) {
  const token = req.headers.cookie?.match(/(?:^|; )sid=([^;]+)/)?.[1];
  return token ? sessions.get(token) : null;
}
function setSession(res, session) {
  const token = createToken();
  sessions.set(token, session);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/`);
}
function clearSession(req, res) {
  const token = req.headers.cookie?.match(/(?:^|; )sid=([^;]+)/)?.[1];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
function requireStudent(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== 'student') return res.status(401).json({ ok: false, error: 'Sesi siswa tidak ditemukan.' });
  req.session = session;
  next();
}
function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== 'admin') return res.status(401).json({ ok: false, error: 'Sesi admin tidak ditemukan.' });
  req.session = session;
  next();
}
function validateMajor(value) { return ['AKUTANSI', 'TBSM', 'TKJ'].includes(value); }
function validateGrade(value) { return ['10', '11', '12'].includes(value); }
function examForStudent(db, student) { return db.exams.find((exam) => exam.id === student.examId); }
function publicQuestion(question) {
  return { id: question.id, number: question.number, text: question.text, options: question.options };
}
function findAttempt(db, studentId, examId) {
  return db.attempts.find((attempt) => attempt.studentId === studentId && attempt.examId === examId);
}
function serializeStudent(db, student) {
  const exam = examForStudent(db, student);
  const attempt = exam ? findAttempt(db, student.id, exam.id) : null;
  return {
    id: student.id,
    name: student.name,
    username: student.username,
    examCode: student.examCode,
    grade: student.grade,
    major: student.major,
    active: student.active,
    exam: exam ? {
      id: exam.id,
      subject: exam.subject,
      title: exam.title,
      startTime: exam.startTime,
      durationMinutes: exam.durationMinutes,
      instructions: exam.instructions
    } : null,
    attempt: attempt ? {
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      answers: attempt.answers,
      score: attempt.score
    } : null
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/config', (req, res) => {
  const db = readDb();
  res.json({ ok: true, settings: db.settings, majors: ['AKUTANSI', 'TBSM', 'TKJ'], grades: ['10', '11', '12'] });
});

app.post('/api/student/login', (req, res) => {
  const username = normalizeKey(req.body.username);
  const examCode = normalizeKey(req.body.examCode);
  if (!username || !examCode) return res.status(400).json({ ok: false, error: 'Username dan kode ujian wajib diisi.' });
  const db = readDb();
  const student = db.students.find((item) => normalizeKey(item.username) === username && normalizeKey(item.examCode) === examCode && item.active !== false);
  if (!student) return res.status(401).json({ ok: false, error: 'Username atau kode ujian tidak cocok.' });
  const exam = examForStudent(db, student);
  if (!exam) return res.status(409).json({ ok: false, error: 'Ujian siswa belum dikonfigurasi admin.' });
  setSession(res, { role: 'student', studentId: student.id });
  res.json({ ok: true, student: serializeStudent(db, student) });
});

app.post('/api/student/logout', requireStudent, (req, res) => { clearSession(req, res); res.json({ ok: true }); });

app.get('/api/student/me', requireStudent, (req, res) => {
  const db = readDb();
  const student = db.students.find((item) => item.id === req.session.studentId);
  if (!student) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  res.json({ ok: true, student: serializeStudent(db, student) });
});

app.post('/api/student/start', requireStudent, (req, res) => {
  const db = readDb();
  const student = db.students.find((item) => item.id === req.session.studentId);
  if (!student) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  const exam = examForStudent(db, student);
  if (!exam) return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });

  const startMs = parseStartTime(exam.startTime);
  if (!Number.isFinite(startMs)) return res.status(500).json({ ok: false, error: 'Waktu mulai ujian tidak valid.' });
  if (nowMs() < startMs) return res.status(403).json({ ok: false, error: `Ujian baru dapat dimulai ${new Date(startMs).toLocaleString('id-ID')}.` });

  const result = mutateDb((nextDb) => {
    let attempt = findAttempt(nextDb, student.id, exam.id);
    if (attempt?.submittedAt) return { attempt, alreadySubmitted: true };
    if (!attempt) {
      attempt = {
        id: createId('attempt'),
        studentId: student.id,
        examId: exam.id,
        startedAt: new Date().toISOString(),
        submittedAt: null,
        answers: {},
        score: null
      };
      nextDb.attempts.push(attempt);
    }
    return { attempt, alreadySubmitted: false };
  });

  res.json({ ok: true, attempt: result.attempt, alreadySubmitted: result.alreadySubmitted });
});

app.get('/api/student/questions', requireStudent, (req, res) => {
  const db = readDb();
  const student = db.students.find((item) => item.id === req.session.studentId);
  if (!student) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  const exam = examForStudent(db, student);
  if (!exam) return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });
  const attempt = findAttempt(db, student.id, exam.id);
  if (!attempt) return res.status(403).json({ ok: false, error: 'Silakan mulai ujian terlebih dahulu.' });

  res.json({
    ok: true,
    exam: {
      subject: exam.subject,
      title: exam.title,
      durationMinutes: exam.durationMinutes,
      startTime: exam.startTime
    },
    questions: db.questions.filter((q) => q.examId === exam.id).sort((a,b) => a.number - b.number).map(publicQuestion),
    attempt: {
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      answers: attempt.answers,
      score: attempt.score
    }
  });
});

app.post('/api/student/answer', requireStudent, (req, res) => {
  const questionId = normalize(req.body.questionId);
  const answer = normalize(req.body.answer).toUpperCase();
  if (!questionId || !['A','B','C','D','E'].includes(answer)) return res.status(400).json({ ok: false, error: 'Jawaban tidak valid.' });

  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    if (!student || !exam) return { error: 'Data ujian tidak ditemukan.', code: 404 };
    const question = db.questions.find((q) => q.id === questionId && q.examId === exam.id);
    if (!question) return { error: 'Soal tidak ditemukan.', code: 404 };
    const attempt = findAttempt(db, student.id, exam.id);
    if (!attempt) return { error: 'Ujian belum dimulai.', code: 403 };
    if (attempt.submittedAt) return { error: 'Ujian sudah dikumpulkan.', code: 409 };
    const expiresAt = parseStartTime(attempt.startedAt) + exam.durationMinutes * 60 * 1000;
    if (exam.durationMinutes > 0 && nowMs() > expiresAt) return { error: 'Waktu ujian sudah habis. Silakan kumpulkan jawaban.', code: 403 };
    attempt.answers[questionId] = answer;
    return { answers: attempt.answers };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, answers: result.answers });
});

app.post('/api/student/submit', requireStudent, (req, res) => {
  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    if (!student || !exam) return { error: 'Data ujian tidak ditemukan.', code: 404 };
    const attempt = findAttempt(db, student.id, exam.id);
    if (!attempt) return { error: 'Ujian belum dimulai.', code: 403 };
    if (attempt.submittedAt) return { attempt };

    const questions = db.questions.filter((q) => q.examId === exam.id);
    const correct = questions.reduce((count, q) => count + (attempt.answers[q.id] === q.answer ? 1 : 0), 0);
    attempt.score = questions.length ? Math.round((correct / questions.length) * 100) : 0;
    attempt.submittedAt = new Date().toISOString();
    return { attempt };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, attempt: result.attempt });
});

app.post('/api/admin/login', (req, res) => {
  const username = normalizeKey(req.body.username);
  const password = normalize(req.body.password);
  const db = readDb();
  const admin = db.admins.find((item) => normalizeKey(item.username) === username && item.password === password);
  if (!admin) return res.status(401).json({ ok: false, error: 'Username atau password admin salah.' });
  setSession(res, { role: 'admin', username: admin.username });
  res.json({ ok: true, username: admin.username });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true, username: req.session.username }));

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const db = readDb();
  const attempts = db.attempts.map((attempt) => {
    const student = db.students.find((s) => s.id === attempt.studentId);
    const exam = db.exams.find((e) => e.id === attempt.examId);
    return {
      ...attempt,
      student: student ? { name: student.name, username: student.username, grade: student.grade, major: student.major } : null,
      exam: exam ? { subject: exam.subject, title: exam.title } : null
    };
  });
  res.json({ ok: true, settings: db.settings, exams: db.exams, students: db.students, questions: db.questions, attempts });
});

app.post('/api/admin/exams', requireAdmin, (req, res) => {
  const subject = normalize(req.body.subject);
  const title = normalize(req.body.title) || `Ujian ${subject}`;
  const startTime = normalize(req.body.startTime);
  const durationMinutes = Number(req.body.durationMinutes || 60);
  const instructions = normalize(req.body.instructions);
  if (!subject || !startTime || !Number.isFinite(parseStartTime(startTime)) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) return res.status(400).json({ ok: false, error: 'Data ujian tidak valid.' });
  const exam = { id: createId('exam'), subject, title, startTime, durationMinutes, instructions };
  mutateDb((db) => db.exams.push(exam));
  res.json({ ok: true, exam });
});

app.put('/api/admin/exams/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const exam = db.exams.find((item) => item.id === req.params.id);
    if (!exam) return null;
    if (req.body.subject !== undefined) exam.subject = normalize(req.body.subject);
    if (req.body.title !== undefined) exam.title = normalize(req.body.title);
    if (req.body.startTime !== undefined) exam.startTime = normalize(req.body.startTime);
    if (req.body.durationMinutes !== undefined) exam.durationMinutes = Number(req.body.durationMinutes);
    if (req.body.instructions !== undefined) exam.instructions = normalize(req.body.instructions);
    return exam;
  });
  if (!result) return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });
  res.json({ ok: true, exam: result });
});

app.delete('/api/admin/exams/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const before = db.exams.length;
    db.exams = db.exams.filter((item) => item.id !== req.params.id);
    db.students = db.students.filter((item) => item.examId !== req.params.id);
    db.questions = db.questions.filter((item) => item.examId !== req.params.id);
    db.attempts = db.attempts.filter((item) => item.examId !== req.params.id);
    return before !== db.exams.length;
  });
  if (!result) return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });
  res.json({ ok: true });
});

app.post('/api/admin/students', requireAdmin, (req, res) => {
  const student = {
    id: createId('student'),
    name: normalize(req.body.name),
    username: normalize(req.body.username),
    examCode: normalize(req.body.examCode),
    grade: normalize(req.body.grade),
    major: normalize(req.body.major).toUpperCase(),
    examId: normalize(req.body.examId),
    active: req.body.active !== false
  };
  if (!student.name || !student.username || !student.examCode || !validateGrade(student.grade) || !validateMajor(student.major)) return res.status(400).json({ ok: false, error: 'Data siswa belum lengkap atau kelas/jurusan tidak valid.' });

  const created = mutateDb((db) => {
    if (!db.exams.some((exam) => exam.id === student.examId)) return null;
    if (db.students.some((s) => normalizeKey(s.username) === normalizeKey(student.username) || normalizeKey(s.examCode) === normalizeKey(student.examCode))) return 'duplicate';
    db.students.push(student);
    return student;
  });

  if (created === null) return res.status(404).json({ ok: false, error: 'Ujian tujuan tidak ditemukan.' });
  if (created === 'duplicate') return res.status(409).json({ ok: false, error: 'Username atau kode ujian sudah digunakan.' });
  res.json({ ok: true, student: created });
});

app.put('/api/admin/students/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.params.id);
    if (!student) return { notFound: true };
    for (const key of ['name','username','examCode','grade','major','examId']) {
      if (req.body[key] !== undefined) student[key] = key === 'major' ? normalize(req.body[key]).toUpperCase() : normalize(req.body[key]);
    }
    if (req.body.active !== undefined) student.active = Boolean(req.body.active);
    return { student };
  });

  if (result.notFound) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  if (!validateGrade(result.student.grade) || !validateMajor(result.student.major)) return res.status(400).json({ ok: false, error: 'Kelas atau jurusan tidak valid.' });
  res.json({ ok: true, student: result.student });
});

app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  const removed = mutateDb((db) => {
    const exists = db.students.some((item) => item.id === req.params.id);
    db.students = db.students.filter((item) => item.id !== req.params.id);
    db.attempts = db.attempts.filter((item) => item.studentId !== req.params.id);
    return exists;
  });
  if (!removed) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  res.json({ ok: true });
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const question = {
    id: createId('question'),
    examId: normalize(req.body.examId),
    number: Number(req.body.number),
    text: normalize(req.body.text),
    options: {
      A: normalize(req.body.A),
      B: normalize(req.body.B),
      C: normalize(req.body.C),
      D: normalize(req.body.D),
      E: normalize(req.body.E)
    },
    answer: normalize(req.body.answer).toUpperCase()
  };

  if (!question.examId || !Number.isInteger(question.number) || question.number < 1 || !question.text ||
      Object.values(question.options).some((v) => !v) || !['A','B','C','D','E'].includes(question.answer)) {
    return res.status(400).json({ ok: false, error: 'Data soal belum lengkap.' });
  }

  const result = mutateDb((db) => {
    if (!db.exams.some((exam) => exam.id === question.examId)) return 'exam-not-found';
    if (db.questions.some((q) => q.examId === question.examId && q.number === question.number)) return 'duplicate-number';
    db.questions.push(question);
    return question;
  });

  if (result === 'exam-not-found') return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });
  if (result === 'duplicate-number') return res.status(409).json({ ok: false, error: 'Nomor soal sudah digunakan pada ujian ini.' });
  res.json({ ok: true, question: result });
});

app.put('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const question = db.questions.find((item) => item.id === req.params.id);
    if (!question) return null;
    if (req.body.number !== undefined) question.number = Number(req.body.number);
    if (req.body.text !== undefined) question.text = normalize(req.body.text);
    for (const key of ['A','B','C','D','E']) {
      if (req.body[key] !== undefined) question.options[key] = normalize(req.body[key]);
    }
    if (req.body.answer !== undefined) question.answer = normalize(req.body.answer).toUpperCase();
    return question;
  });

  if (!result) return res.status(404).json({ ok: false, error: 'Soal tidak ditemukan.' });
  res.json({ ok: true, question: result });
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const removed = mutateDb((db) => {
    const exists = db.questions.some((item) => item.id === req.params.id);
    db.questions = db.questions.filter((item) => item.id !== req.params.id);
    return exists;
  });
  if (!removed) return res.status(404).json({ ok: false, error: 'Soal tidak ditemukan.' });
  res.json({ ok: true });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    if (req.body.schoolName !== undefined) db.settings.schoolName = normalize(req.body.schoolName);
    if (req.body.schoolSubtitle !== undefined) db.settings.schoolSubtitle = normalize(req.body.schoolSubtitle);
    return db.settings;
  });
  res.json({ ok: true, settings: result });
});

app.use('/admin', express.static(path.join(__dirname, 'public/admin'), { index: 'index.html' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Terjadi kesalahan server.' });
});

app.listen(PORT, () => {
  console.log(`Website Ujian aktif di http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});
