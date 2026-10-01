let state = {
  exam: null,
  questions: [],
  answers: {},
  doubts: {},
  current: 0,
  startedAt: null,
  submitting: false,
  leaving: false
};

let timerId = null;
let heartbeatId = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function fmtTime(totalSec) {
  const s = Math.max(0, totalSec);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

function renderQuestion() {
  const q = state.questions[state.current];

  if (!q) {
    document.getElementById('questionNumber').textContent = 'Tidak ada soal';
    document.getElementById('questionText').textContent = 'Ujian belum memiliki soal.';
    document.getElementById('options').innerHTML = '';
    document.getElementById('prevBtn').disabled = true;
    document.getElementById('nextBtn').disabled = true;
    document.getElementById('doubtBtn').disabled = true;
    document.getElementById('submitBtn').disabled = true;
    return;
  }

  const selected = state.answers[q.id];
  const doubtful = Boolean(state.doubts[q.id]);

  document.getElementById('questionNumber').textContent = `Soal ${q.number}`;
  document.getElementById('questionText').textContent = q.text;
  document.getElementById('saveState').textContent = selected ? `Jawaban ${selected} tersimpan` : 'Belum memilih';

  document.getElementById('options').innerHTML = Object.entries(q.options).map(([key, value]) => {
    const checked = selected === key;
    return `
      <label class="option ${checked ? 'selected' : ''}">
        <input type="radio" name="answer" value="${escapeHtml(key)}" ${checked ? 'checked' : ''}>
        <div><strong>${escapeHtml(key)}.</strong> ${escapeHtml(value)}</div>
      </label>
    `;
  }).join('');

  document.querySelectorAll('input[name="answer"]').forEach((input) => input.addEventListener('change', choose));

  const doubtBtn = document.getElementById('doubtBtn');
  doubtBtn.disabled = false;
  doubtBtn.classList.toggle('active', doubtful);
  doubtBtn.textContent = doubtful ? '⚑ Hapus Tanda Ragu-ragu' : '⚑ Tandai Ragu-ragu';

  document.getElementById('prevBtn').disabled = state.current === 0;
  document.getElementById('nextBtn').disabled = state.questions.length === 0;
  document.getElementById('nextBtn').textContent = state.current === state.questions.length - 1 ? 'Selesai →' : 'Berikutnya →';

  renderGrid();
}

function renderGrid() {
  document.getElementById('qgrid').innerHTML = state.questions.map((q, index) => {
    const doubtful = Boolean(state.doubts[q.id]);
    const done = Boolean(state.answers[q.id]);
    const className = doubtful ? 'doubt' : (done ? 'done' : '');
    return `<button type="button" class="qbtn ${className}" data-i="${index}" title="${doubtful ? 'Ditandai ragu-ragu' : done ? 'Sudah dijawab' : 'Belum dijawab'}">${q.number}</button>`;
  }).join('');

  document.querySelectorAll('.qbtn').forEach((button) => {
    button.addEventListener('click', () => {
      state.current = Number(button.dataset.i);
      renderQuestion();
    });
  });
}

async function choose(event) {
  const q = state.questions[state.current];
  const answer = event.target.value;
  const previous = state.answers[q.id];

  state.answers[q.id] = answer;
  renderQuestion();
  document.getElementById('saveState').textContent = 'Menyimpan...';

  try {
    const response = await fetch('/api/student/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: q.id, answer })
    });
    const data = await response.json();

    if (response.status === 423 || data.locked) {
      state.leaving = true;
      return location.href = '/unlock.html';
    }

    if (!response.ok) {
      if (previous) state.answers[q.id] = previous;
      else delete state.answers[q.id];
      renderQuestion();
      document.getElementById('saveState').textContent = 'Gagal menyimpan';
      return;
    }

    state.answers = data.answers || state.answers;
    document.getElementById('saveState').textContent = `Jawaban ${answer} tersimpan`;
    renderGrid();
  } catch {
    if (previous) state.answers[q.id] = previous;
    else delete state.answers[q.id];
    renderQuestion();
    document.getElementById('saveState').textContent = 'Gagal menyimpan';
  }
}

async function toggleDoubt() {
  const q = state.questions[state.current];
  if (!q) return;

  const value = !Boolean(state.doubts[q.id]);
  const button = document.getElementById('doubtBtn');
  button.disabled = true;

  try {
    const response = await fetch('/api/student/doubt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: q.id, value })
    });
    const data = await response.json();

    if (response.status === 423 || data.locked) {
      state.leaving = true;
      return location.href = '/unlock.html';
    }

    if (!response.ok) throw new Error(data.error || 'Gagal menyimpan tanda ragu-ragu.');

    state.doubts = data.doubts || state.doubts;
    renderQuestion();
  } catch {
    button.disabled = false;
    document.getElementById('saveState').textContent = 'Gagal menyimpan tanda ragu-ragu';
  }
}

function updateTimer() {
  if (!state.startedAt || !state.exam) return;

  const started = new Date(state.startedAt).getTime();
  const duration = Number(state.exam.durationMinutes) * 60;
  const remaining = duration - Math.floor((Date.now() - started) / 1000);

  document.getElementById('timer').textContent = fmtTime(remaining);

  if (remaining <= 0 && !state.submitting) {
    clearInterval(timerId);
    submitExam(true);
  }
}

async function submitExam(auto = false) {
  if (state.submitting) return;

  if (!auto) {
    const confirmed = window.confirm('Yakin semua jawaban sudah selesai dan ingin mengumpulkan?');
    if (!confirmed) return;
  }

  state.submitting = true;
  state.leaving = true;

  const button = document.getElementById('submitBtn');
  button.disabled = true;

  try {
    const response = await fetch('/api/student/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    if (!response.ok) {
      if (response.status === 423 || data.locked) {
        return location.href = '/unlock.html';
      }
      document.getElementById('submitMessage').innerHTML = `<div class="error">${escapeHtml(data.error || 'Gagal mengumpulkan ujian.')}</div>`;
      state.submitting = false;
      state.leaving = false;
      button.disabled = false;
      return;
    }

    window.removeEventListener('beforeunload', preventLeave);
    clearInterval(heartbeatId);
    location.href = '/dashboard.html?submitted=1';
  } catch {
    document.getElementById('submitMessage').innerHTML = '<div class="error">Server tidak merespons. Coba kumpulkan lagi.</div>';
    state.submitting = false;
    state.leaving = false;
    button.disabled = false;
  }
}

function preventLeave(event) {
  if (!state.leaving && !state.submitting) {
    event.preventDefault();
    event.returnValue = '';
  }
}

function lockOnLeave() {
  if (state.leaving || state.submitting) return;

  const body = JSON.stringify({ reason: 'Siswa meninggalkan halaman ujian.' });

  try {
    fetch('/api/student/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin'
    }).catch(() => {});
  } catch {
    // Browser may not allow async requests during pagehide.
  }
}

async function heartbeat() {
  if (state.leaving || state.submitting) return;
  try {
    const response = await fetch('/api/student/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (response.status === 423) {
      state.leaving = true;
      location.href = '/unlock.html';
    }
  } catch {
    // A temporary network error is handled by the server-side stale timer.
  }
}

async function load() {
  const response = await fetch('/api/student/questions', { cache: 'no-store' });
  const data = await response.json();

  if (response.status === 423 || data.locked) return location.href = '/unlock.html';
  if (response.status === 409 && data.submitted) return location.href = '/dashboard.html';
  if (!response.ok) return location.href = '/instruction.html';

  state.exam = data.exam;
  state.questions = Array.isArray(data.questions) ? data.questions : [];
  state.answers = data.attempt.answers || {};
  state.doubts = data.attempt.doubts || {};
  state.startedAt = data.attempt.startedAt;

  document.getElementById('subjectLabel').textContent = data.exam.subject;

  renderQuestion();
  updateTimer();
  timerId = setInterval(updateTimer, 1000);
  heartbeatId = setInterval(heartbeat, 5000);

  if (!state.questions.length) {
    document.getElementById('submitMessage').innerHTML = '<div class="error">Ujian belum memiliki soal. Hubungi admin.</div>';
  }

  window.addEventListener('beforeunload', preventLeave);
  window.addEventListener('pagehide', lockOnLeave);
}

document.getElementById('prevBtn').addEventListener('click', () => {
  if (state.current > 0) {
    state.current -= 1;
    renderQuestion();
  }
});

document.getElementById('nextBtn').addEventListener('click', () => {
  if (!state.questions.length) return;
  if (state.current < state.questions.length - 1) {
    state.current += 1;
    renderQuestion();
  } else {
    document.getElementById('qgrid').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

document.getElementById('doubtBtn').addEventListener('click', toggleDoubt);
document.getElementById('submitBtn').addEventListener('click', () => submitExam(false));

load().catch(() => location.href = '/instruction.html');
