let student=null;

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatDate(value){const d=new Date(value);return Number.isNaN(d.getTime())?'-':d.toLocaleString('id-ID',{dateStyle:'full',timeStyle:'short'});}

function getStatus(student){
  const exam=student.exam;
  if(!exam) return {key:'none',title:'Belum ada ujian',description:'Akun ini belum mendapatkan ujian dari admin.',className:'warn'};
  const attempt=student.attempt;
  if(attempt?.submittedAt) return {key:'submitted',title:'Ujian sudah dikumpulkan',description:'Jawaban sudah tersimpan. Nilai tidak ditampilkan di akun siswa.',className:'good'};
  if(attempt?.lockedAt) return {key:'locked',title:'Ujian terkunci',description:'Sesi pengerjaan terputus. Minta kode unlock kepada admin untuk melanjutkan.',className:'warn'};
  const start=new Date(exam.startTime).getTime();
  if(Number.isFinite(start)&&Date.now()<start) return {key:'scheduled',title:'Belum dimulai',description:`Ujian baru dapat dimulai pada ${formatDate(exam.startTime)}.`,className:'warn'};
  if(attempt?.startedAt) return {key:'running',title:'Sedang dikerjakan',description:'Ujian sedang berlangsung. Buka halaman soal untuk melanjutkan.',className:'good'};
  return {key:'ready',title:'Siap dimulai',description:'Jadwal sudah masuk. Kamu dapat membuka halaman pemberitahuan untuk memulai ujian.',className:'good'};
}

function render(){
  const exam=student?.exam;
  const status=getStatus(student||{});
  document.getElementById('statusTitle').textContent=status.title;
  document.getElementById('statusDescription').textContent=status.description;
  document.getElementById('statusTitle').className=status.className==='good'?'good-text':'warn-text';
  document.getElementById('subject').textContent=exam?.subject||'-';
  document.getElementById('examTitle').textContent=exam?.title||'-';
  document.getElementById('schedule').textContent=exam?formatDate(exam.startTime):'-';
  document.getElementById('duration').textContent=exam?`Durasi ${exam.durationMinutes} menit`:'-';

  const answers=student?.attempt?.answers||{};
  const questionsCount=Number(window.__questionCount||0);
  const answeredCount=Object.keys(answers).length;
  document.getElementById('progress').textContent=questionsCount?`${answeredCount} / ${questionsCount} soal`:String(answeredCount);

  let action='';
  if(status.key==='submitted') action='<a class="btn btn-ghost" href="/dashboard.html">Kembali ke Dashboard</a>';
  else if(status.key==='locked') action='<a class="btn btn-primary" href="/unlock.html">Buka Halaman Unlock</a>';
  else if(status.key==='running') action='<a class="btn btn-primary" href="/exam.html">Lanjut Mengerjakan</a>';
  else if(status.key==='scheduled'||status.key==='ready') action='<a class="btn btn-primary" href="/instruction.html">Buka Pemberitahuan Ujian</a>';
  else action='<a class="btn btn-ghost" href="/dashboard.html">Kembali</a>';
  document.getElementById('statusAction').innerHTML=action;
}

async function load(){
  const response=await fetch('/api/student/me',{cache:'no-store'});
  const data=await response.json();
  if(!response.ok)return location.href='/';
  student=data.student;

  const config=await fetch('/api/config',{cache:'no-store'});
  if(config.ok){
    const cfg=await config.json();
    document.getElementById('schoolName').textContent=cfg.settings.schoolName;
    document.getElementById('schoolSubtitle').textContent=cfg.settings.schoolSubtitle;
  }

  // Ambil jumlah soal dari endpoint yang sama dengan halaman ujian,
  // tetapi jangan memblokir status jika endpoint sedang tidak tersedia.
  if(student.exam && student.attempt && !student.attempt.submittedAt){
    const qResponse=await fetch('/api/student/questions',{cache:'no-store'});
    if(qResponse.ok){
      const qData=await qResponse.json();
      window.__questionCount=qData.questions?.length||0;
      student.attempt=qData.attempt;
      student.exam={...student.exam,...qData.exam};
    }
  }
  render();
}
document.getElementById('logoutBtn').addEventListener('click',async()=>{try{await fetch('/api/student/logout',{method:'POST'});}finally{location.href='/';}});
load().catch(()=>location.href='/dashboard.html');
