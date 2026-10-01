const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');

function readSeed() {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

function ensureShape(db) {
  let changed = false;
  const seed = readSeed();

  for (const key of ['settings', 'admins', 'exams', 'students', 'questions', 'attempts']) {
    const fallback = key === 'settings' ? { ...seed.settings } : [];
    if (db[key] === undefined) {
      db[key] = fallback;
      changed = true;
    }
  }

  const bindoExam = db.exams.find((exam) => exam.id === 'exam-bindo-2026');
  if (bindoExam) {
    const existingIds = new Set(db.questions.map((question) => question.id));
    for (const question of seed.questions.filter((item) => item.examId === bindoExam.id)) {
      if (!existingIds.has(question.id)) {
        db.questions.push(JSON.parse(JSON.stringify(question)));
        changed = true;
      }
    }
  }

  return changed;
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.copyFileSync(SEED_FILE, DB_FILE);
  }
}

function readDb() {
  ensureDb();
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (ensureShape(db)) writeDb(db);
    return db;
  } catch (error) {
    throw new Error('Database lokal rusak atau tidak dapat dibaca.');
  }
}

function writeDb(db) {
  ensureDb();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function mutateDb(mutator) {
  const db = readDb();
  const result = mutator(db);
  writeDb(db);
  return result;
}

module.exports = { readDb, writeDb, mutateDb };
