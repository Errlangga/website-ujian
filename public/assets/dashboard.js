let student=null;

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatDate(value){const date=new Date(value);return Number.isNaN(date.getTime())?'-':date.toLocaleString('id-ID',{dateStyle:'full',timeStyle:'short'});}

async function load(){
  const response=await fetch('/api/student/me',{cache:'no-store'});
  const data=await response.json();
  if(!response.ok)return location.href='/';
  student=data.student;

  if(student.attempt?.lockedAt)return location.href='/unlock.html';

  const configResponse=await fetch('/api/config',{cache:'no-store'});
  if(configResponse.ok){
    const config=await configResponse.json();
    document.getElementById('schoolName').textContent=config.settings.schoolName;
    document.getElementById('schoolSubtitle').textContent=config.settings.schoolSubtitle;
  }

  document.getElementById('hello').textContent=`Halo, ${student.name}`;
  document.getElementById('profile').textContent=`Kelas ${student.grade} · ${student.major} · username ${student.username}`;

  const content=document.getElementById('content');
  if(!student.exam){
    content.innerHTML='<div class="error">Belum ada ujian yang ditugaskan ke akun ini.</div>';
    return;
  }

  const submitted=Boolean(student.attempt?.submittedAt);
  content.innerHTML=`
    <div class="cards">
      <article class="card subject-card">
        <span class="badge good">Mata pelajaran</span>
        <h3>${escapeHtml(student.exam.subject)}</h3>
        <p>${escapeHtml(student.exam.title)}</p>
        <p class="muted">Klik kartu ini untuk melihat jadwal dan petunjuk sebelum ujian.</p>
        <a class="btn btn-primary" href="${submitted?'/status.html':'/instruction.html'}" style="display:inline-block">${submitted?'Lihat Status Ujian':'Buka Mata Pelajaran'}</a>
      </article>
      <article class="card">
        <span class="badge">Jadwal</span>
        <h3>${escapeHtml(formatDate(student.exam.startTime))}</h3>
        <p class="muted">Durasi ${student.exam.durationMinutes} menit.</p>
        <span class="badge ${submitted?'good':'warn'}">${submitted?'Ujian sudah dikumpulkan':'Belum dikumpulkan'}</span>
      </article>
      <article class="card">
        <span class="badge">Petunjuk</span>
        <p class="muted" style="line-height:1.7">${escapeHtml(student.exam.instructions||'Ikuti instruksi pengawas sebelum menekan mulai ujian.')}</p>
      </article>
    </div>
  `;
}

document.getElementById('logoutBtn').addEventListener('click',async()=>{
  const button=document.getElementById('logoutBtn');
  button.disabled=true;
  try{await fetch('/api/student/logout',{method:'POST'});}finally{location.href='/';}
});
load().catch(()=>location.href='/');
