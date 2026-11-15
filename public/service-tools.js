function crewAddDayButton(){
 return state.service?.closed?'':`<button type="button" class="crew-add-day" onclick="crewOpenAddDay()" aria-label="Añadir día" title="Añadir día">
 <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
}
function crewOpenAddDay(){
 const dialog=document.getElementById('crewAddDay');
 const form=document.getElementById('crewAddDayForm');
 const days=getDays().map(parseDateString).filter(Boolean);
 const latest=days.at(-1)||parseDateString(state.service?.serviceDate);
 const date=latest?new Date(latest):new Date();
 if(latest)date.setDate(date.getDate()+1);
 form.reset();
 form.elements.date.value=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
 document.getElementById('crewAddDayStatus').textContent='';
 dialog.showModal();
}
document.getElementById('crewAddDayForm').addEventListener('submit',async event=>{
 event.preventDefault();
 const form=event.currentTarget;
 const code=state.service?.code;
 if(!code||state.service.closed)return;
 const date=form.elements.date.value.split('-').reverse().join('/');
 const file=form.elements.pdf.files[0];
 const button=form.querySelector('button');
 const status=document.getElementById('crewAddDayStatus');
 button.disabled=true;
 try{
  const saved=await crewSaveLatest(code,remote=>({...remote,addedDays:[...new Set([...(remote.addedDays||[]),date])]}));
  if(state.service?.code!==code)return;
  state.service.addedDays=saved.addedDays;
  crewMobileSelectedWorks.clear();
  crewMobileSelectedShifts.clear();
  crewOpSelectedWorks.clear();
  crewOpSelectedTimes.clear();
  setActiveDay(date);
  form.closest('dialog').close();
  if(file)await importPdf(file,date);
 }catch(error){status.textContent=error.message;}
 finally{button.disabled=false;}
});

const managerUI={
 dialog:document.getElementById('crewManager'),
 status:document.getElementById('crewManagerStatus'),
 login:document.getElementById('crewManagerLogin'),
 password:document.getElementById('crewManagerPassword'),
 toolbar:document.getElementById('crewManagerToolbar'),
 list:document.getElementById('crewManagerList')
};
async function crewManagerApi(action,payload){
 const response=await fetch('/api/manager/'+action,payload===undefined?{cache:'no-store'}:{
  method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(payload)
 });
 const data=await response.json();
 if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});
 return data;
}
function crewManagerView(mode){
 managerUI.login.hidden=mode!=='login';
 managerUI.password.hidden=true;
 if(mode==='setup')crewShowManagerPassword(true);
 managerUI.toolbar.hidden=mode!=='services';
 if(mode!=='services')managerUI.list.replaceChildren();
 managerUI.status.textContent=mode==='setup'?'Cambia la contraseña inicial para activar el acceso.':'';
}
function crewShowManagerPassword(setup){
 const form=managerUI.password;
 form.reset();
 form.dataset.setup=String(setup);
 document.getElementById('crewManagerCurrentPassword').hidden=setup;
 form.elements.current.disabled=setup;
 form.hidden=false;
}
async function crewOpenManager(){
 crewManagerView('loading');
 managerUI.dialog.showModal();
 try{
  const session=await crewManagerApi('session');
  if(session.setup)crewManagerView('setup');
  else await crewRefreshManager();
 }catch(error){
  crewManagerView('login');
  if(error.status!==401)managerUI.status.textContent=error.message;
 }
}
async function crewRefreshManager(){
 try{
  const {services}=await crewManagerApi('services');
  crewManagerView('services');
  managerUI.list.replaceChildren();
  if(!services.length)managerUI.status.textContent='Todavía no hay servicios.';
  for(const service of services)managerUI.list.append(crewManagerCard(service));
 }catch(error){
  if(error.status===401)crewManagerView('login');
  managerUI.status.textContent=error.message;
 }
}
async function crewManagerLogout(){
 try{await crewManagerApi('logout',{});crewManagerView('login');}
 catch(error){managerUI.status.textContent=error.message;}
}
function crewManagerForm(form,action,onSuccess){
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  const submit=form.querySelector('button');
  submit.disabled=true;
  managerUI.status.textContent='';
  try{
   const payload=Object.fromEntries(new FormData(form));
   if(action==='password'){
    if(payload.password.length<12||payload.password.length>256)throw new Error('La contraseña nueva debe tener entre 12 y 256 caracteres.');
    if(payload.password!==payload.repeat)throw new Error('Las contraseñas nuevas no coinciden.');
    delete payload.repeat;
    managerUI.status.textContent='Guardando contraseña…';
   }
   const result=await crewManagerApi(action,payload);
   if(action==='password')managerUI.status.textContent='Contraseña guardada. Cargando servicios…';
   form.reset();
   await onSuccess(result);
  }catch(error){managerUI.status.textContent=error.message;}
  finally{submit.disabled=false;}
 });
}
crewManagerForm(managerUI.login,'login',result=>result.setup?crewManagerView('setup'):crewRefreshManager());
crewManagerForm(managerUI.password,'password',crewRefreshManager);
function crewManagerCard(service){
 const article=document.createElement('article');
 article.className='crew-manager-card';
 const title=document.createElement('strong');
 title.textContent=service.name||'Servicio '+service.code;
 const status=document.createElement('span');
 status.className='crew-manager-state';
 status.dataset.closed=String(!!service.closed);
 status.textContent=service.closed?'Cerrado':'Abierto';
 const details=document.createElement('p');
 details.textContent=[service.code,service.date,service.workers+' registros',service.pdf].filter(Boolean).join(' · ');
 const types=document.createElement('p');
 types.textContent=service.types?.split(',').join(' · ')||'';
 types.hidden=!service.types;
 const actions=document.createElement('div');
 actions.className='crew-manager-actions';
 const button=(label,callback)=>{
  const element=document.createElement('button');
  element.type='button';
  element.className='secondary';
  element.textContent=label;
  element.onclick=async()=>{
   element.disabled=true;
   try{await callback();}
   catch(error){managerUI.status.textContent=error.message;}
   finally{element.disabled=false;}
  };
  actions.append(element);
 };
 const open=async()=>{
  const loaded=await dispatchBackend('loadService',[service.code]);
  openServiceData(loaded);
  managerUI.dialog.close();
 };
 button('Acceder',open);
 if(service.closed){
  button('Descargar Excel',async()=>{
   const {service:closed}=await crewApi(service.code);
   if(!closed.closed)throw new Error('El servicio se ha reabierto. Actualiza la lista.');
   await downloadClosedServiceExcel(false,false,closed);
  });
 }else{
  const input=document.createElement('input');
  input.type='file';
  input.accept='.pdf,application/pdf';
  input.hidden=true;
  input.onchange=async()=>{
   const file=input.files[0];
   if(!file)return;
   try{
    const loaded=await dispatchBackend('loadService',[service.code]);
    if(loaded.closed)throw new Error('El servicio ya está cerrado. Actualiza la lista.');
    openServiceData(loaded);
    managerUI.dialog.close();
    await importPdf(file);
   }catch(error){managerUI.status.textContent=error.message;}
   finally{input.value='';}
  };
  button(service.pdf?'Actualizar PDF':'Importar PDF',()=>input.click());
  actions.append(input);
 }
 article.append(title,status,details,types,actions);
 return article;
}
