const form=document.getElementById('unlockForm');
const message=document.getElementById('unlockMessage');
const codeInput=document.getElementById('code');

async function check(){
  const response=await fetch('/api/student/me',{cache:'no-store'});
  const data=await response.json();
  if(!response.ok)return location.href='/';
  if(data.student.attempt?.submittedAt)return location.href='/dashboard.html';
  if(!data.student.attempt?.lockedAt)return location.href='/exam.html';
}
form.addEventListener('submit',async(e)=>{
  e.preventDefault();
  const button=form.querySelector('button');
  button.disabled=true;
  message.innerHTML='<div class="notice">Memeriksa kode unlock...</div>';
  try{
    const response=await fetch('/api/student/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:codeInput.value.trim()})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Kode unlock tidak valid.');
    location.href='/exam.html';
  }catch(error){
    message.innerHTML='<div class="error">'+String(error.message).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+'</div>';
  }finally{button.disabled=false;}
});
document.getElementById('logoutBtn').addEventListener('click',async()=>{
  await fetch('/api/student/logout',{method:'POST'});
  location.href='/';
});
check().catch(()=>location.href='/');
