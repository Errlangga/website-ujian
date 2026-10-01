let state = {
  exam: null,
  questions: [],
  answers: {},
  current: 0,
  startedAt: null,
  submitting: false
};
let timerId = null;

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
    document.getElementById('submitBtn').disabled = true;
    return;
  }

  const selected = state.answers[q.id];
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
  document.getElementById('prevBtn').disabled = state.current === 0;
  document.getElementById('nextBtn').disabled = state.questions.length === 0;
  document.getElementById('nextBtn').textContent = state.current === state.questions.length - 1 ? 'Selesai →' : 'Berikutnya →';
  renderGrid();
}

function renderGrid() {
  document.getElementById('qgrid').innerHTML = state.questions.map((q, index) => {
    return `<button type="button" class="qbtn ${state.answers[q.id] ? 'done' : ''}" data-i="${index}">${q.number}</button>`;
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

    if (!response.ok) {
      if (previous) state.answers[q.id] = previous;
      else delete state.answers[q.id];
      renderQuestion();
      document.getElementById('saveState').textContent = 'Gagal menyimpan';
      if (response.status === 403) {
        await submitExam(true);
      }
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
  state.submitting = true;

  const button = document.getElementById('submitBtn');
  button.disabled = true;

  if (!auto) {
    const confirmed = window.confirm('Yakin semua jawaban sudah selesai dan ingin mengumpulkan?');
    if (!confirmed) {
      state.submitting = false;
      button.disabled = false;
      return;
    }
  }

  try {
    const response = await fetch('/api/student/submit', { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      document.getElementById('submitMessage').innerHTML = `<div class="error">${escapeHtml(data.error || 'Gagal mengumpulkan ujian.')}</div>`;
      state.submitting = false;
      button.disabled = false;
      return;
    }

    window.removeEventListener('beforeunload', preventLeave);
    location.href = '/dashboard.html?submitted=1';
  } catch {
    document.getElementById('submitMessage').innerHTML = '<div class="error">Server tidak merespons. Coba kumpulkan lagi.</div>';
    state.submitting = false;
    button.disabled = false;
  }
}

function preventLeave(event) {
  if (!state.submitting) {
    event.preventDefault();
    event.returnValue = '';
  }
}

async function load() {
  const response = await fetch('/api/student/questions', { cache: 'no-store' });
  const data = await response.json();

  if (!response.ok) return location.href = '/instruction.html';
  if (data.attempt?.submittedAt) return location.href = '/dashboard.html';

  state.exam = data.exam;
  state.questions = Array.isArray(data.questions) ? data.questions : [];
  state.answers = data.attempt.answers || {};
  state.startedAt = data.attempt.startedAt;

  document.getElementById('subjectLabel').textContent = data.exam.subject;

  renderQuestion();
  updateTimer();
  timerId = setInterval(updateTimer, 1000);

  if (!state.questions.length) {
    document.getElementById('submitMessage').innerHTML = '<div class="error">Ujian belum memiliki soal. Hubungi admin.</div>';
  }

  window.addEventListener('beforeunload', preventLeave);
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

document.getElementById('submitBtn').addEventListener('click', () => submitExam(false));

load().catch(() => location.href = '/instruction.html');
