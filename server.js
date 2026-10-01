const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { readDb, mutateDb } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 12;
const LOCK_STALE_MS = 25 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'website-ujian-local-session-secret-change-me';

const loginAttempts = new Map();

const MAJORS = ['AKUTANSI', 'TBSM', 'TKJ'];
const GRADES = ['10', '11', '12'];
const ANSWERS = ['A', 'B', 'C', 'D', 'E'];

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

function nowMs() {
  return Date.now();
}

function createId(prefix) {
  return prefix + '-' + crypto.randomBytes(8).toString('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalize(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return normalize(value).toLowerCase();
}

function parseStartTime(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function validString(value, min, max) {
  const text = normalize(value);
  return text.length >= min && text.length <= max;
}

function validateMajor(value) {
  return MAJORS.includes(value);
}

function validateGrade(value) {
  return GRADES.includes(value);
}

function validateAnswer(value) {
  return ANSWERS.includes(value);
}

function sessionCookieName(role) {
  return role === 'admin' ? 'admin_sid' : 'student_sid';
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signSession(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function encodeSession(sessionData) {
  const payload = base64url(JSON.stringify({
    ...sessionData,
    exp: nowMs() + SESSION_TTL_MS
  }));
  return payload + '.' + signSession(payload);
}

function decodeSession(raw, expectedRole) {
  try {
    const parts = String(raw || '').split('.');
    if (parts.length !== 2) return null;
    const payload = parts[0];
    const signature = parts[1];
    const expected = signSession(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.role !== expectedRole || !data.exp || data.exp <= nowMs()) return null;
    return data;
  } catch {
    return null;
  }
}

function getSessionToken(req, role) {
  const cookieName = sessionCookieName(role);
  return req.headers.cookie?.match(new RegExp('(?:^|; )' + cookieName + '=([^;]+)'))?.[1] || null;
}

function getSession(req, role) {
  const token = getSessionToken(req, role);
  return decodeSession(token, role);
}

function setSession(res, sessionData) {
  const cookieName = sessionCookieName(sessionData.role);
  const token = encodeSession(sessionData);
  res.setHeader('Set-Cookie', cookieName + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000));
}

function clearSession(req, res, role) {
  const currentRole = role || req.session?.role;
  const roles = currentRole ? [currentRole] : ['admin', 'student'];
  for (const current of roles) {
    res.append('Set-Cookie', sessionCookieName(current) + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  }
}

function requireStudent(req, res, next) {
  const session = getSession(req, 'student');
  if (!session || session.role !== 'student') {
    return res.status(401).json({ ok: false, error: 'Sesi siswa tidak ditemukan.' });
  }
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req, 'admin');
  if (!session || session.role !== 'admin') {
    return res.status(401).json({ ok: false, error: 'Sesi admin tidak ditemukan.' });
  }
  req.session = session;
  next();
}

function examForStudent(db, student) {
  return db.exams.find((exam) => exam.id === student.examId) || null;
}

function findAttempt(db, studentId, examId) {
  return db.attempts.find((attempt) => attempt.studentId === studentId && attempt.examId === examId) || null;
}

function questionCount(db, examId) {
  return db.questions.filter((question) => question.examId === examId).length;
}

function publicQuestion(question) {
  return {
    id: question.id,
    number: question.number,
    text: question.text,
    options: question.options
  };
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
    active: student.active !== false,
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
      answers: { ...(attempt.answers || {}) },
      doubts: { ...(attempt.doubts || {}) },
      lockedAt: attempt.lockedAt || null,
      lockReason: attempt.lockReason || null
    } : null
  };
}

function isAttemptExpired(attempt, exam) {
  if (!attempt || !exam || !attempt.startedAt) return false;
  const startedMs = parseStartTime(attempt.startedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(Number(exam.durationMinutes))) return false;
  return nowMs() >= startedMs + Number(exam.durationMinutes) * 60 * 1000;
}

function calculateScore(db, attempt, examId) {
  const questions = db.questions.filter((question) => question.examId === examId);
  if (!questions.length) return 0;
  const correct = questions.reduce((total, question) => {
    return total + (attempt.answers?.[question.id] === question.answer ? 1 : 0);
  }, 0);
  return Math.round((correct / questions.length) * 100);
}

function finalizeAttempt(attempt, db, exam) {
  if (!attempt.submittedAt) {
    attempt.score = calculateScore(db, attempt, exam.id);
    attempt.submittedAt = new Date().toISOString();
    attempt.lockedAt = null;
    attempt.unlockCode = null;
    attempt.lastSeenAt = null;
  }
  return attempt;
}

function generateUnlockCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function lockAttempt(attempt, reason) {
  if (!attempt || attempt.submittedAt) return attempt;
  if (!attempt.lockedAt) {
    attempt.lockedAt = new Date().toISOString();
    attempt.lockReason = reason || 'Keluar dari halaman ujian';
    attempt.unlockCode = generateUnlockCode();
    attempt.unlockAttempts = 0;
  }
  attempt.lastSeenAt = null;
  return attempt;
}

function unlockAttempt(attempt, code) {
  if (!attempt || !attempt.lockedAt || !attempt.unlockCode) return false;
  if (String(code).trim() !== String(attempt.unlockCode)) return false;
  attempt.lockedAt = null;
  attempt.lockReason = null;
  attempt.unlockCode = null;
  attempt.unlockAttempts = 0;
  attempt.lastSeenAt = new Date().toISOString();
  return true;
}

function markStaleAttempt(attempt) {
  if (!attempt || attempt.submittedAt || attempt.lockedAt || !attempt.lastSeenAt) return false;
  const lastSeen = new Date(attempt.lastSeenAt).getTime();
  if (!Number.isFinite(lastSeen) || nowMs() - lastSeen <= LOCK_STALE_MS) return false;
  lockAttempt(attempt, 'Aktivitas ujian terputus');
  return true;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const value = normalize(stored);
  if (value.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = value.split('$');
    if (!saltHex || !hashHex || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length || 32);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  return value === password;
}

function loginKey(req, username) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `${ip}|${username}`;
}

function checkLoginRateLimit(req, username) {
  const key = loginKey(req, username);
  const now = nowMs();
  const bucket = loginAttempts.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + LOGIN_WINDOW_MS;
  }
  if (bucket.count >= MAX_LOGIN_ATTEMPTS) {
    return { blocked: true, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  loginAttempts.set(key, bucket);
  return { blocked: false };
}

function clearSuccessfulLoginRate(req, username) {
  loginAttempts.delete(loginKey(req, username));
}

function validateExamInput(input) {
  const subject = normalize(input.subject);
  const title = normalize(input.title);
  const startTime = normalize(input.startTime);
  const durationMinutes = Number(input.durationMinutes);
  const instructions = normalize(input.instructions);
  if (!validString(subject, 1, 100)) return { error: 'Mata pelajaran wajib diisi dan maksimal 100 karakter.' };
  if (!validString(title, 1, 160)) return { error: 'Judul ujian wajib diisi dan maksimal 160 karakter.' };
  if (!Number.isFinite(parseStartTime(startTime))) return { error: 'Waktu mulai ujian tidak valid.' };
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600) return { error: 'Durasi harus antara 1 sampai 600 menit.' };
  if (instructions.length > 3000) return { error: 'Petunjuk maksimal 3000 karakter.' };
  return { subject, title, startTime, durationMinutes, instructions };
}

function validateStudentInput(input) {
  const student = {
    name: normalize(input.name),
    username: normalize(input.username),
    examCode: normalize(input.examCode),
    grade: normalize(input.grade),
    major: normalize(input.major).toUpperCase(),
    examId: normalize(input.examId),
    active: input.active !== false
  };
  if (!validString(student.name, 1, 120)) return { error: 'Nama siswa wajib diisi dan maksimal 120 karakter.' };
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(student.username)) return { error: 'Username hanya boleh berisi huruf, angka, titik, garis bawah, dan strip (3-50 karakter).' };
  if (!/^[A-Za-z0-9_-]{4,50}$/.test(student.examCode)) return { error: 'Kode ujian hanya boleh berisi huruf, angka, garis bawah, dan strip (4-50 karakter).' };
  if (!validateGrade(student.grade)) return { error: 'Kelas harus 10, 11, atau 12.' };
  if (!validateMajor(student.major)) return { error: 'Jurusan harus AKUTANSI, TBSM, atau TKJ.' };
  if (!student.examId) return { error: 'Ujian harus dipilih.' };
  return { student };
}

function validateQuestionInput(input) {
  const question = {
    examId: normalize(input.examId),
    number: Number(input.number),
    text: normalize(input.text),
    options: {
      A: normalize(input.A),
      B: normalize(input.B),
      C: normalize(input.C),
      D: normalize(input.D),
      E: normalize(input.E)
    },
    answer: normalize(input.answer).toUpperCase()
  };
  if (!question.examId) return { error: 'Ujian harus dipilih.' };
  if (!Number.isInteger(question.number) || question.number < 1 || question.number > 500) return { error: 'Nomor soal harus 1 sampai 500.' };
  if (!validString(question.text, 1, 10000)) return { error: 'Pertanyaan wajib diisi dan maksimal 10000 karakter.' };
  if (Object.entries(question.options).some(([, value]) => !validString(value, 1, 5000))) return { error: 'Semua pilihan A-E wajib diisi dan maksimal 5000 karakter.' };
  if (!validateAnswer(question.answer)) return { error: 'Kunci jawaban harus A, B, C, D, atau E.' };
  return { question };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
  const db = readDb();
  res.json({
    ok: true,
    settings: db.settings,
    majors: MAJORS,
    grades: GRADES
  });
});

app.post('/api/student/login', (req, res) => {
  const username = normalize(req.body.username);
  const examCode = normalize(req.body.examCode);
  if (!username || !examCode) return res.status(400).json({ ok: false, error: 'Username dan kode ujian wajib diisi.' });

  const rate = checkLoginRateLimit(req, normalizeKey(username));
  if (rate.blocked) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ ok: false, error: `Terlalu banyak percobaan. Coba lagi dalam ${rate.retryAfter} detik.` });
  }

  const db = readDb();
  const student = db.students.find((item) =>
    normalizeKey(item.username) === normalizeKey(username) &&
    normalizeKey(item.examCode) === normalizeKey(examCode) &&
    item.active !== false
  );
  if (!student) return res.status(401).json({ ok: false, error: 'Username atau kode ujian tidak cocok.' });

  const exam = examForStudent(db, student);
  if (!exam) return res.status(409).json({ ok: false, error: 'Ujian siswa belum dikonfigurasi admin.' });

  clearSuccessfulLoginRate(req, normalizeKey(username));
  setSession(res, { role: 'student', studentId: student.id });
  res.json({ ok: true, student: serializeStudent(db, student) });
});

app.post('/api/student/logout', requireStudent, (req, res) => {
  clearSession(req, res, 'student');
  res.json({ ok: true });
});

app.get('/api/student/me', requireStudent, (req, res) => {
  const db = readDb();
  const student = db.students.find((item) => item.id === req.session.studentId);
  if (!student || student.active === false) return res.status(404).json({ ok: false, error: 'Akun siswa tidak ditemukan atau sudah dinonaktifkan.' });

  const exam = examForStudent(db, student);
  if (exam) {
    const attempt = findAttempt(db, student.id, exam.id);
    if (attempt && !attempt.submittedAt) {
      if (markStaleAttempt(attempt) || isAttemptExpired(attempt, exam)) {
        if (isAttemptExpired(attempt, exam)) finalizeAttempt(attempt, db, exam);
        mutateDb((nextDb) => {
          const persisted = findAttempt(nextDb, student.id, exam.id);
          if (!persisted) return;
          if (isAttemptExpired(persisted, exam)) finalizeAttempt(persisted, nextDb, exam);
          else if (attempt.lockedAt) lockAttempt(persisted, attempt.lockReason || 'Aktivitas ujian terputus');
        });
      }
    }
  }

  const freshDb = readDb();
  const freshStudent = freshDb.students.find((item) => item.id === student.id);
  res.json({ ok: true, serverNow: new Date().toISOString(), student: serializeStudent(freshDb, freshStudent) });
});

app.post('/api/student/start', requireStudent, (req, res) => {
  const db = readDb();
  const student = db.students.find((item) => item.id === req.session.studentId);
  if (!student || student.active === false) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  const exam = examForStudent(db, student);
  if (!exam) return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });
  if (questionCount(db, exam.id) === 0) return res.status(409).json({ ok: false, error: 'Ujian belum memiliki soal. Hubungi admin.' });

  const startMs = parseStartTime(exam.startTime);
  if (!Number.isFinite(startMs)) return res.status(500).json({ ok: false, error: 'Waktu mulai ujian tidak valid.' });
  if (nowMs() < startMs) {
    return res.status(403).json({ ok: false, error: `Ujian baru dapat dimulai ${new Date(startMs).toLocaleString('id-ID')}.` });
  }

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
        doubts: {},
        score: null,
        lockedAt: null,
        lockReason: null,
        unlockCode: null,
        unlockAttempts: 0,
        lastSeenAt: new Date().toISOString()
      };
      nextDb.attempts.push(attempt);
    }
    return { attempt, alreadySubmitted: false };
  });

  res.json({
    ok: true,
    attempt: result.attempt,
    alreadySubmitted: result.alreadySubmitted
  });
});

app.get('/api/student/questions', requireStudent, (req, res) => {
  const db = readDb();
  const student = db.students.find((item) => item.id === req.session.studentId);
  if (!student || student.active === false) return res.status(404).json({ ok: false, error: 'Siswa tidak ditemukan.' });
  const exam = examForStudent(db, student);
  if (!exam) return res.status(404).json({ ok: false, error: 'Ujian tidak ditemukan.' });

  const attempt = findAttempt(db, student.id, exam.id);
  if (!attempt) return res.status(403).json({ ok: false, error: 'Silakan mulai ujian terlebih dahulu.' });

  markStaleAttempt(attempt);
  if (attempt.lockedAt) {
    mutateDb((nextDb) => {
      const persisted = findAttempt(nextDb, student.id, exam.id);
      if (persisted) lockAttempt(persisted, attempt.lockReason || 'Aktivitas ujian terputus');
    });
    return res.status(423).json({ ok: false, locked: true, error: 'Ujian terkunci. Masukkan kode unlock dari admin.' });
  }

  if (!attempt.submittedAt && isAttemptExpired(attempt, exam)) {
    mutateDb((nextDb) => {
      const persisted = findAttempt(nextDb, student.id, exam.id);
      if (persisted) finalizeAttempt(persisted, nextDb, exam);
    });
  }

  const freshDb = readDb();
  const freshAttempt = findAttempt(freshDb, student.id, exam.id);
  if (freshAttempt?.submittedAt) {
    return res.status(409).json({ ok: false, submitted: true, error: 'Ujian sudah dikumpulkan.' });
  }

  if (!freshAttempt) return res.status(403).json({ ok: false, error: 'Percobaan ujian tidak ditemukan.' });

  freshAttempt.lastSeenAt = new Date().toISOString();
  mutateDb((nextDb) => {
    const persisted = findAttempt(nextDb, student.id, exam.id);
    if (persisted && !persisted.submittedAt && !persisted.lockedAt) persisted.lastSeenAt = new Date().toISOString();
  });

  const latestDb = readDb();
  const latestAttempt = findAttempt(latestDb, student.id, exam.id);
  res.json({
    ok: true,
    serverNow: new Date().toISOString(),
    exam: {
      subject: exam.subject,
      title: exam.title,
      durationMinutes: exam.durationMinutes,
      startTime: exam.startTime,
      questionCount: questionCount(latestDb, exam.id)
    },
    questions: latestDb.questions
      .filter((q) => q.examId === exam.id)
      .sort((a, b) => a.number - b.number)
      .map(publicQuestion),
    attempt: {
      startedAt: latestAttempt.startedAt,
      submittedAt: latestAttempt.submittedAt,
      answers: { ...(latestAttempt.answers || {}) },
      doubts: { ...(latestAttempt.doubts || {}) }
    }
  });
});

app.post('/api/student/heartbeat', requireStudent, (req, res) => {
  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    const attempt = student && exam ? findAttempt(db, student.id, exam.id) : null;
    if (!student || !exam || !attempt) return { error: 'Percobaan ujian tidak ditemukan.', code: 404 };
    if (attempt.submittedAt) return { error: 'Ujian sudah dikumpulkan.', code: 409 };
    if (attempt.lockedAt) return { error: 'Ujian terkunci.', code: 423 };
    if (isAttemptExpired(attempt, exam)) {
      finalizeAttempt(attempt, db, exam);
      return { expired: true };
    }
    attempt.lastSeenAt = new Date().toISOString();
    return { ok: true };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json(result);
});

app.post('/api/student/lock', requireStudent, (req, res) => {
  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    const attempt = student && exam ? findAttempt(db, student.id, exam.id) : null;
    if (!student || !exam || !attempt) return { error: 'Percobaan ujian tidak ditemukan.', code: 404 };
    if (attempt.submittedAt) return { ok: true, alreadySubmitted: true };
    if (isAttemptExpired(attempt, exam)) {
      finalizeAttempt(attempt, db, exam);
      return { ok: true, expired: true };
    }
    lockAttempt(attempt, normalize(req.body.reason) || 'Keluar dari halaman ujian');
    return { ok: true, locked: true };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json(result);
});

app.post('/api/student/unlock', requireStudent, (req, res) => {
  const code = normalize(req.body.code);
  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    const attempt = student && exam ? findAttempt(db, student.id, exam.id) : null;
    if (!student || !exam || !attempt) return { error: 'Percobaan ujian tidak ditemukan.', code: 404 };
    if (attempt.submittedAt) return { error: 'Ujian sudah dikumpulkan.', code: 409 };
    if (!attempt.lockedAt) return { ok: true };
    if (isAttemptExpired(attempt, exam)) {
      finalizeAttempt(attempt, db, exam);
      return { error: 'Waktu ujian sudah habis.', code: 410 };
    }
    attempt.unlockAttempts = Number(attempt.unlockAttempts || 0) + 1;
    if (attempt.unlockAttempts > 5) return { error: 'Terlalu banyak percobaan kode unlock. Hubungi admin.', code: 429 };
    if (!unlockAttempt(attempt, code)) return { error: 'Kode unlock salah.', code: 401 };
    return { ok: true };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json(result);
});

app.post('/api/student/answer', requireStudent, (req, res) => {
  const questionId = normalize(req.body.questionId);
  const answer = normalize(req.body.answer).toUpperCase();
  if (!questionId || !validateAnswer(answer)) return res.status(400).json({ ok: false, error: 'Jawaban tidak valid.' });

  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    if (!student || student.active === false || !exam) return { error: 'Data ujian tidak ditemukan.', code: 404 };

    const question = db.questions.find((q) => q.id === questionId && q.examId === exam.id);
    if (!question) return { error: 'Soal tidak ditemukan.', code: 404 };

    const attempt = findAttempt(db, student.id, exam.id);
    if (!attempt) return { error: 'Ujian belum dimulai.', code: 403 };
    if (attempt.submittedAt) return { error: 'Ujian sudah dikumpulkan.', code: 409 };
    if (attempt.lockedAt) return { error: 'Ujian terkunci.', code: 423 };
    if (isAttemptExpired(attempt, exam)) return { error: 'Waktu ujian sudah habis.', code: 403 };

    attempt.answers = { ...(attempt.answers || {}), [questionId]: answer };
    attempt.lastSeenAt = new Date().toISOString();
    return { answers: attempt.answers };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, answers: result.answers });
});

app.post('/api/student/doubt', requireStudent, (req, res) => {
  const questionId = normalize(req.body.questionId);
  const value = Boolean(req.body.value);
  if (!questionId) return res.status(400).json({ ok: false, error: 'Soal tidak valid.' });

  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    const attempt = student && exam ? findAttempt(db, student.id, exam.id) : null;
    const question = exam ? db.questions.find((item) => item.id === questionId && item.examId === exam.id) : null;
    if (!student || !exam || !attempt || !question) return { error: 'Data soal tidak ditemukan.', code: 404 };
    if (attempt.submittedAt) return { error: 'Ujian sudah dikumpulkan.', code: 409 };
    if (attempt.lockedAt) return { error: 'Ujian terkunci.', code: 423 };
    if (isAttemptExpired(attempt, exam)) return { error: 'Waktu ujian sudah habis.', code: 403 };

    attempt.doubts = { ...(attempt.doubts || {}) };
    if (value) attempt.doubts[questionId] = true;
    else delete attempt.doubts[questionId];
    attempt.lastSeenAt = new Date().toISOString();
    return { doubts: attempt.doubts };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, doubts: result.doubts });
});

app.post('/api/student/submit', requireStudent, (req, res) => {
  const result = mutateDb((db) => {
    const student = db.students.find((item) => item.id === req.session.studentId);
    const exam = student ? examForStudent(db, student) : null;
    if (!student || student.active === false || !exam) return { error: 'Data ujian tidak ditemukan.', code: 404 };

    const attempt = findAttempt(db, student.id, exam.id);
    if (!attempt) return { error: 'Ujian belum dimulai.', code: 403 };
    if (attempt.submittedAt) return { attempt };
    if (attempt.lockedAt) return { error: 'Ujian terkunci. Minta kode unlock kepada admin.', code: 423 };

    finalizeAttempt(attempt, db, exam);
    return { attempt };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, submittedAt: result.attempt.submittedAt });
});

app.post('/api/admin/login', (req, res) => {
  const username = normalize(req.body.username);
  const password = normalize(req.body.password);
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Username dan password wajib diisi.' });

  const rate = checkLoginRateLimit(req, `admin:${normalizeKey(username)}`);
  if (rate.blocked) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ ok: false, error: `Terlalu banyak percobaan. Coba lagi dalam ${rate.retryAfter} detik.` });
  }

  const db = readDb();
  const admin = db.admins.find((item) => normalizeKey(item.username) === normalizeKey(username));
  if (!admin || !verifyPassword(password, admin.password)) {
    return res.status(401).json({ ok: false, error: 'Username atau password admin salah.' });
  }

  if (!String(admin.password).startsWith('scrypt$')) {
    const replacement = hashPassword(password);
    mutateDb((nextDb) => {
      const current = nextDb.admins.find((item) => normalizeKey(item.username) === normalizeKey(username));
      if (current) current.password = replacement;
    });
  }

  clearSuccessfulLoginRate(req, `admin:${normalizeKey(username)}`);
  setSession(res, { role: 'admin', username: admin.username });
  res.json({ ok: true, username: admin.username });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  clearSession(req, res, 'admin');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.session.username });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const currentPassword = normalize(req.body.currentPassword);
  const newPassword = normalize(req.body.newPassword);
  if (newPassword.length < 8 || newPassword.length > 200) {
    return res.status(400).json({ ok: false, error: 'Password baru harus 8-200 karakter.' });
  }

  const result = mutateDb((db) => {
    const admin = db.admins.find((item) => normalizeKey(item.username) === normalizeKey(req.session.username));
    if (!admin || !verifyPassword(currentPassword, admin.password)) return { error: 'Password lama salah.', code: 401 };
    admin.password = hashPassword(newPassword);
    // Session cookie ditandatangani; tidak perlu menyimpan token session di database.
    db.sessions = sessionsList.filter((session) => !(session.role === 'admin' && normalizeKey(session.username) === normalizeKey(req.session.username)));
    return { ok: true };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  clearSession(req, res, 'admin');
  res.json({ ok: true, message: 'Password berhasil diganti. Silakan login kembali.' });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const db = readDb();
  const attempts = db.attempts.map((attempt) => {
    const student = db.students.find((student) => student.id === attempt.studentId);
    const exam = db.exams.find((exam) => exam.id === attempt.examId);
    return {
      id: attempt.id,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      score: attempt.score,
      lockedAt: attempt.lockedAt || null,
      lockReason: attempt.lockReason || null,
      unlockCode: attempt.lockedAt ? attempt.unlockCode || null : null,
      student: student ? {
        id: student.id,
        name: student.name,
        username: student.username,
        grade: student.grade,
        major: student.major
      } : null,
      exam: exam ? {
        id: exam.id,
        subject: exam.subject,
        title: exam.title
      } : null
    };
  });
  res.json({
    ok: true,
    settings: db.settings,
    exams: db.exams,
    students: db.students,
    questions: db.questions,
    attempts
  });
});

app.post('/api/admin/unlock/:attemptId', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const attempt = db.attempts.find((item) => item.id === req.params.attemptId);
    if (!attempt) return { error: 'Percobaan ujian tidak ditemukan.', code: 404 };
    const exam = db.exams.find((item) => item.id === attempt.examId);
    if (!exam) return { error: 'Ujian tidak ditemukan.', code: 404 };
    if (attempt.submittedAt) return { error: 'Ujian sudah dikumpulkan.', code: 409 };
    attempt.lockedAt = null;
    attempt.lockReason = null;
    attempt.unlockCode = null;
    attempt.unlockAttempts = 0;
    attempt.lastSeenAt = new Date().toISOString();
    return { ok: true };
  });
  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json(result);
});

app.post('/api/admin/exams', requireAdmin, (req, res) => {
  const parsed = validateExamInput(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

  const exam = {
    id: createId('exam'),
    ...parsed,
  };

  mutateDb((db) => db.exams.push(exam));
  res.json({ ok: true, exam });
});

app.put('/api/admin/exams/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const exam = db.exams.find((item) => item.id === req.params.id);
    if (!exam) return { error: 'Ujian tidak ditemukan.', code: 404 };

    const candidateInput = {
      subject: req.body.subject ?? exam.subject,
      title: req.body.title ?? exam.title,
      startTime: req.body.startTime ?? exam.startTime,
      durationMinutes: req.body.durationMinutes ?? exam.durationMinutes,
      instructions: req.body.instructions ?? exam.instructions
    };
    const parsed = validateExamInput(candidateInput);
    if (parsed.error) return { error: parsed.error, code: 400 };

    Object.assign(exam, parsed);
    return { exam };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, exam: result.exam });
});

app.delete('/api/admin/exams/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const exists = db.exams.some((item) => item.id === req.params.id);
    if (!exists) return { error: 'Ujian tidak ditemukan.', code: 404 };

    const linkedAttempts = db.attempts.some((attempt) => attempt.examId === req.params.id);
    if (linkedAttempts) return { error: 'Ujian sudah memiliki riwayat pengerjaan. Hapus tidak diizinkan.', code: 409 };

    db.exams = db.exams.filter((item) => item.id !== req.params.id);
    db.students = db.students.filter((item) => item.examId !== req.params.id);
    db.questions = db.questions.filter((item) => item.examId !== req.params.id);
    return { ok: true };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true });
});

app.post('/api/admin/students', requireAdmin, (req, res) => {
  const parsed = validateStudentInput(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

  const created = mutateDb((db) => {
    if (!db.exams.some((exam) => exam.id === parsed.student.examId)) return { error: 'Ujian tujuan tidak ditemukan.', code: 404 };
    const duplicate = db.students.some((student) =>
      normalizeKey(student.username) === normalizeKey(parsed.student.username) ||
      normalizeKey(student.examCode) === normalizeKey(parsed.student.examCode)
    );
    if (duplicate) return { error: 'Username atau kode ujian sudah digunakan.', code: 409 };
    const student = { id: createId('student'), ...parsed.student };
    db.students.push(student);
    return { student };
  });

  if (created.error) return res.status(created.code).json({ ok: false, error: created.error });
  res.json({ ok: true, student: created.student });
});

app.put('/api/admin/students/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const current = db.students.find((student) => student.id === req.params.id);
    if (!current) return { error: 'Siswa tidak ditemukan.', code: 404 };

    const parsed = validateStudentInput({
      ...current,
      ...req.body,
      active: req.body.active === undefined ? current.active !== false : Boolean(req.body.active)
    });
    if (parsed.error) return { error: parsed.error, code: 400 };

    const duplicate = db.students.some((student) =>
      student.id !== current.id &&
      (normalizeKey(student.username) === normalizeKey(parsed.student.username) ||
       normalizeKey(student.examCode) === normalizeKey(parsed.student.examCode))
    );
    if (duplicate) return { error: 'Username atau kode ujian sudah digunakan oleh siswa lain.', code: 409 };

    Object.assign(current, parsed.student);
    return { student: current };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, student: result.student });
});

app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const exists = db.students.some((student) => student.id === req.params.id);
    if (!exists) return { error: 'Siswa tidak ditemukan.', code: 404 };

    db.students = db.students.filter((student) => student.id !== req.params.id);
    db.attempts = db.attempts.filter((attempt) => attempt.studentId !== req.params.id);
    return { ok: true };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true });
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const parsed = validateQuestionInput(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

  const result = mutateDb((db) => {
    if (!db.exams.some((exam) => exam.id === parsed.question.examId)) return { error: 'Ujian tidak ditemukan.', code: 404 };
    if (db.questions.some((question) => question.examId === parsed.question.examId && question.number === parsed.question.number)) {
      return { error: 'Nomor soal sudah digunakan pada ujian ini.', code: 409 };
    }
    const question = { id: createId('question'), ...parsed.question };
    db.questions.push(question);
    return { question };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, question: result.question });
});

app.put('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const current = db.questions.find((question) => question.id === req.params.id);
    if (!current) return { error: 'Soal tidak ditemukan.', code: 404 };

    const parsed = validateQuestionInput({
      ...current,
      ...current.options,
      ...req.body,
      examId: req.body.examId ?? current.examId,
      number: req.body.number ?? current.number,
      text: req.body.text ?? current.text,
      answer: req.body.answer ?? current.answer
    });
    if (parsed.error) return { error: parsed.error, code: 400 };

    if (db.questions.some((question) =>
      question.id !== current.id &&
      question.examId === parsed.question.examId &&
      question.number === parsed.question.number
    )) {
      return { error: 'Nomor soal sudah digunakan pada ujian ini.', code: 409 };
    }

    Object.assign(current, parsed.question);
    return { question: current };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, question: result.question });
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const exists = db.questions.some((question) => question.id === req.params.id);
    if (!exists) return { error: 'Soal tidak ditemukan.', code: 404 };
    db.questions = db.questions.filter((question) => question.id !== req.params.id);
    return { ok: true };
  });

  if (result.error) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const schoolName = normalize(req.body.schoolName);
  const schoolSubtitle = normalize(req.body.schoolSubtitle);
  if (!validString(schoolName, 1, 160) || !validString(schoolSubtitle, 1, 240)) {
    return res.status(400).json({ ok: false, error: 'Nama sekolah atau subjudul tidak valid.' });
  }

  const settings = mutateDb((db) => {
    db.settings.schoolName = schoolName;
    db.settings.schoolSubtitle = schoolSubtitle;
    return db.settings;
  });

  res.json({ ok: true, settings });
});

app.use('/admin', express.static(path.join(__dirname, 'public/admin'), { index: 'index.html' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: 'Terjadi kesalahan server.' });
});

app.listen(PORT, () => {
  console.log(`Website Ujian aktif di http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});
