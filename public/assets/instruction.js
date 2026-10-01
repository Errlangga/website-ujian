let exam=null;
let timerId=null;

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function format(value){const date=new Date(value);return Number.isNaN(date.getTime())?'-':date.toLocaleString('id-ID',{dateStyle:'full',timeStyle:'short'});}

function render(){
  if(!exam)return;
  const now=Date.now();
  const start=new Date(exam.startTime).getTime();
  const button=document.getElementById('startBtn');
  if(!Number.isFinite(start)){button.disabled=true;document.getElementById('countdown').textContent='Jadwal ujian tidak valid.';return;}
  if(now>=start){document.getElementById('countdown').textContent='Ujian sudah dapat dimulai.';button.disabled=false;}
  else{const sec=Math.max(0,Math.floor((start-now)/1000));const h=String(Math.floor(sec/3600)).padStart(2,'0');const m=String(Math.floor((sec%3600)/60)).padStart(2,'0');const s=String(sec%60).padStart(2,'0');document.getElementById('countdown').textContent=`Mulai dalam ${h}:${m}:${s}`;button.disabled=true;}
}

async function load(){
  const response=await fetch('/api/student/me',{cache:'no-store'});
  const data=await response.json();
  if(!response.ok)return location.href='/';
  if(data.student.attempt?.lockedAt)return location.href='/unlock.html';
  if(data.student.attempt?.submittedAt)return location.href='/dashboard.html';
  if(!data.student.exam)return location.href='/dashboard.html';

  exam=data.student.exam;
  document.getElementById('subject').textContent=exam.subject;
  document.getElementById('title').textContent=exam.title;
  document.getElementById('schedule').textContent=`Ujian akan dimulai pada ${format(exam.startTime)} · durasi ${exam.durationMinutes} menit.`;
  document.getElementById('instructions').textContent=exam.instructions||'Tidak ada petunjuk tambahan.';
  render();
  timerId=setInterval(render,1000);
}

document.getElementById('startBtn').addEventListener('click',async()=>{
  const button=document.getElementById('startBtn');
  const message=document.getElementById('message');
  button.disabled=true;
  try{
    const response=await fetch('/api/student/start',{method:'POST'});
    const data=await response.json();
    if(!response.ok){message.innerHTML=`<div class="error">${escapeHtml(data.error||'Ujian belum dapat dimulai.')}</div>`;render();return;}
    if(data.alreadySubmitted)return location.href='/dashboard.html';
    clearInterval(timerId);
    location.href='/exam.html';
  }catch{message.innerHTML='<div class="error">Tidak dapat menghubungi server ujian. Coba lagi.</div>';render();}
});
load().catch(()=>location.href='/');
