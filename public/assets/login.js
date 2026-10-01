async function getConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Konfigurasi sekolah gagal dimuat.');
  return response.json();
}

async function checkExistingSession() {
  const response = await fetch('/api/student/me', { cache: 'no-store' });
  if (response.ok) location.href = '/dashboard.html';
}

async function init() {
  try {
    const { settings } = await getConfig();
    if (settings) {
      document.getElementById('schoolName').textContent = settings.schoolName;
      document.getElementById('schoolSubtitle').textContent = settings.schoolSubtitle;
    }
  } catch {
    // Halaman login tetap dapat digunakan walau config gagal dimuat.
  }
  checkExistingSession().catch(() => {});
}

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const message = document.getElementById('loginMessage');
  const button = event.currentTarget.querySelector('button');
  const examCode = document.getElementById('examCode').value.trim();
  const username = document.getElementById('username').value.trim();

  if (!examCode || !username) {
    message.innerHTML = '<div class="error">Kode ujian dan username wajib diisi.</div>';
    return;
  }

  button.disabled = true;
  message.innerHTML = '<div class="notice">Memeriksa akses ujian...</div>';

  try {
    const response = await fetch('/api/student/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examCode, username })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Gagal masuk.');

    location.href = '/dashboard.html';
  } catch (error) {
    message.innerHTML = `<div class="error">${String(error.message).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</div>`;
  } finally {
    button.disabled = false;
  }
});

init();
