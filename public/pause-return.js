/* Crew Control — regreso de pausa por turno, independiente del estado de asistencia. */
(function(){
  'use strict';
  const STATES=['PENDIENTE','CONTACTADO','PRESENTE','NO PRESENTADO'];
  const LABELS={'PENDIENTE':'PENDIENTE','CONTACTADO':'CONTACTADO','PRESENTE':'PRESENTE','NO PRESENTADO':'NO PRESENTADO'};
  let activeShiftId='';
  let fromPeople=false;
  let lastAutoCheck=0;
  const $=id=>document.getElementById(id);
  const icon=status=>{
    const p={
      PENDIENTE:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
      CONTACTADO:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.8L7.1 10a16 16 0 0 0 6.9 6.9l1.5-1.9a2 2 0 0 1 1.8-.6l3 .5a2 2 0 0 1 1.7 2Z"/>',
      PRESENTE:'<circle cx="12" cy="12" r="9"/><path d="m7.5 12 3.1 3.1 6-6"/>',
      'NO PRESENTADO':'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'
    };
    return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p[status]+'</svg>';
  };
  function getShift(){return crewPauseRecords().find(s=>s.id===activeShiftId)}
  function getWorkers(shift){
    const ids=new Set((shift.workerIds||[]).map(String));
    return (state.service?.workers||[]).filter(w=>w.included&&w.serviceDate===shift.serviceDate&&
      normalize(w.trabajo)===normalize(shift.trabajo)&&ids.has(String(w.id)));
  }
  function getStatus(shift,id){
    const status=shift.returnStatuses?.[String(id)]||'PENDIENTE';
    return STATES.includes(status)?status:'PENDIENTE';
  }
  function initialize(){
    if(!$('crewPausePeopleModal')||!$('crewPauseShiftList'))return;
    const modal=document.createElement('div');
    modal.id='crewPauseReturnModal';
    modal.className='modal hidden';
    modal.innerHTML=
      '<div class="modal-card crew-pause-card crew-pause-return-card" role="dialog" aria-modal="true" aria-labelledby="crewPauseReturnTitle">'+
        '<div class="modal-head"><div><h3 id="crewPauseReturnTitle">Regreso de la pausa</h3><div id="crewPauseReturnSub" class="modal-sub"></div></div>'+
          '<button type="button" class="modal-close crew-return-close" aria-label="Cerrar control de regreso"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>'+
        '<div id="crewPauseReturnStats" class="crew-return-stats" aria-live="polite"></div>'+
        '<div id="crewPauseReturnMissing" class="crew-return-missing" aria-live="polite"></div>'+
        '<div class="crew-return-list-head"><span>Pasar lista del regreso</span><small id="crewPauseReturnTotal"></small></div>'+
        '<div id="crewPauseReturnList" class="crew-return-list"></div>'+
        '<div class="modal-actions"><button type="button" class="crew-return-back">Volver</button></div>'+
      '</div>';
    document.body.appendChild(modal);
    const inShiftButton=document.createElement('button');
    inShiftButton.type='button';
    inShiftButton.className='crew-pause-return-open';
    inShiftButton.textContent='Pasar lista del regreso';
    inShiftButton.addEventListener('click',()=>openReturn(crewPauseOpenId));
    $('crewPausePeopleModal').querySelector('.modal-actions').prepend(inShiftButton);
    modal.addEventListener('click',e=>{
      if(e.target===modal||e.target.closest('.crew-return-close,.crew-return-back'))closeReturn();
    });
    // Selector nativo: permite elegir los cuatro estados sin menús recortados en móvil.
    $('crewPauseReturnList').addEventListener('change',e=>{
      const select=e.target.closest('select[data-return-worker]');
      if(select)setStatus(select.dataset.returnWorker,select.value);
    });
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!modal.classList.contains('hidden')){e.stopPropagation();closeReturn()}
    });
    const list=$('crewPauseShiftList');
    new MutationObserver(decorateShiftButtons).observe(list,{childList:true});
    decorateShiftButtons();
    // Revisión en la app abierta, al recuperar el foco y al acceder a pasar lista.
    setInterval(()=>autoCloseEndedShifts(),15000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)autoCloseEndedShifts()});
    window.addEventListener('focus',()=>autoCloseEndedShifts());

    // Al sacar a alguien de un turno, borrar únicamente su control de regreso en ese turno.
    // La función original sigue gestionando las asignaciones y su guardado.
    const originalToggle=window.crewPauseToggleWorker;
    if(typeof originalToggle==='function'){
      window.crewPauseToggleWorker=function(shiftId,workerId,checked){
        const shift=crewPauseRecords().find(s=>s.id===shiftId);
        if(shift){
          crewPauseRecords().filter(s=>s.serviceDate===shift.serviceDate&&normalize(s.trabajo)===normalize(shift.trabajo))
            .forEach(s=>{if(s.returnStatuses)delete s.returnStatuses[String(workerId)]});
        }
        return originalToggle.apply(this,arguments);
      };
    }
  }
  function decorateShiftButtons(){
    if(!state.service)return;
    const shifts=crewPauseRecords().filter(s=>s.serviceDate===state.activeDay&&normalize(s.trabajo)===normalize(crewPauseWork))
      .sort((a,b)=>a.start.localeCompare(b.start));
    $('crewPauseShiftList').querySelectorAll('.crew-pause-collapsed').forEach((card,i)=>{
      if(card.querySelector('.crew-pause-return-shortcut')||!shifts[i])return;
      const button=document.createElement('button');
      button.type='button';
      button.className='crew-pause-return-shortcut';
      button.textContent='Pasar lista';
      const id=shifts[i].id;
      button.addEventListener('click',()=>openReturn(id));
      card.insertBefore(button,card.lastElementChild);
    });
  }
  function shiftEndDate(shift){
    const raw=String(shift.serviceDate||'').trim();
    let y,m,d;
    let match=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if(match){y=+match[1];m=+match[2];d=+match[3]}
    else{
      match=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if(!match)return null;
      d=+match[1];m=+match[2];y=+match[3];
    }
    const time=String(shift.end||'').match(/^(\d{1,2}):(\d{2})$/);
    const start=String(shift.start||'').match(/^(\d{1,2}):(\d{2})$/);
    if(!time||!start||m<1||m>12||d<1||d>31||+time[1]>23||+time[2]>59)return null;
    const end=new Date(y,m-1,d,+time[1],+time[2],0,0);
    if(end.getFullYear()!==y||end.getMonth()!==m-1||end.getDate()!==d)return null;
    if((+time[1]*60 + +time[2]) <= (+start[1]*60 + +start[2]))end.setDate(end.getDate()+1);
    return end;
  }
  function autoCloseEndedShifts(){
    if(!state.service||state.service.closed)return;
    const now=Date.now();
    if(now-lastAutoCheck<1000)return;
    lastAutoCheck=now;
    const events=[];
    crewPauseRecords().forEach(shift=>{
      const end=shiftEndDate(shift);
      if(!end||now<end.getTime())return;
      if(!shift.returnStatuses||typeof shift.returnStatuses!=='object'||Array.isArray(shift.returnStatuses))shift.returnStatuses={};
      getWorkers(shift).forEach(w=>{
        const id=String(w.id),status=getStatus(shift,id);
        if(status==='PENDIENTE'||status==='CONTACTADO'){
          shift.returnStatuses[id]='NO PRESENTADO';
          events.push({kind:'return',id:shift.id,workerId:id,status:'NO PRESENTADO'});
        }
      });
    });
    if(events.length){
      events.forEach(event=>crewPauseSave(event));
      if(activeShiftId&&!$('crewPauseReturnModal').classList.contains('hidden'))renderReturn();
    }
  }
  function openReturn(id){
    if(!state.service)return;
    const shift=crewPauseRecords().find(s=>s.id===id);
    if(!shift)return;
    autoCloseEndedShifts();
    fromPeople=!$('crewPausePeopleModal').classList.contains('hidden');
    activeShiftId=shift.id;
    $('crewPauseReturnTitle').textContent='Regreso de la pausa · '+shift.start+' – '+shift.end;
    $('crewPauseReturnSub').textContent=shift.trabajo+' · '+shift.serviceDate;
    $('crewPausePeopleModal').classList.add('hidden');
    $('crewPauseShiftsModal').classList.add('hidden');
    renderReturn();
    $('crewPauseReturnModal').classList.remove('hidden');
  }
  function closeReturn(){
    $('crewPauseReturnModal').classList.add('hidden');
    $('crewPauseShiftsModal').classList.remove('hidden');
    if(fromPeople&&crewPauseOpenId){
      crewPauseRenderPeople();
      $('crewPausePeopleModal').classList.remove('hidden');
    }else{
      renderCrewPauseShifts();
    }
    activeShiftId='';
    fromPeople=false;
  }
  function setStatus(workerId,status){
    if(!state.service||state.service.closed||!STATES.includes(status))return;
    const shift=getShift();
    if(!shift||!(shift.workerIds||[]).map(String).includes(String(workerId)))return;
    if(!shift.returnStatuses||typeof shift.returnStatuses!=='object'||Array.isArray(shift.returnStatuses))shift.returnStatuses={};
    if(status==='PENDIENTE')delete shift.returnStatuses[String(workerId)];
    else shift.returnStatuses[String(workerId)]=status;
    crewPauseSave({kind:'return',id:shift.id,workerId:String(workerId),status});  // Persist only this return status in D1.
    renderReturn();
    renderCrewPauseShifts();
  }
  function renderReturn(){
    const shift=getShift();if(!shift)return;
    const workers=getWorkers(shift),counts={PENDIENTE:0,CONTACTADO:0,PRESENTE:0,'NO PRESENTADO':0};
    workers.forEach(w=>counts[getStatus(shift,w.id)]++);
    $('crewPauseReturnStats').innerHTML=
      [['CONTACTADO','Contactados'],['PRESENTE','Presentes'],['NO PRESENTADO','No presentados']]
        .map(([status,label])=>'<div class="crew-return-stat" data-status="'+status+'"><span>'+label+'</span><strong>'+counts[status]+'</strong></div>').join('');
    const missing=workers.filter(w=>getStatus(shift,w.id)!=='PRESENTE');
    $('crewPauseReturnMissing').innerHTML=
      '<strong>'+(missing.length?'Faltan por volver: '+missing.length:'Todo el personal ha regresado')+'</strong>'+
      '<small>'+counts.PENDIENTE+' pendientes · '+counts.CONTACTADO+' contactados · '+counts['NO PRESENTADO']+' no presentados</small>'+
      (missing.length?'<div class="crew-return-missing-names">'+missing.map(w=>'<span>'+escapeHtml(w.personal)+'</span>').join('')+'</div>':'');
    $('crewPauseReturnTotal').textContent=workers.length+' personas del turno';
    const list=$('crewPauseReturnList');
    if(!workers.length){
      list.innerHTML='<div class="hint">Este turno todavía no tiene trabajadores asignados. Añádelos desde Personal del turno.</div>';return;
    }
    list.innerHTML=workers.map(w=>{
      const status=getStatus(shift,w.id),team=(state.service.teams||[]).find(t=>t.id===w.teamId);
      const teamName=team?.name||'SIN EQUIPO',specialty=w.especialidad||'SIN ESPECIALIDAD';
      const phone=typeof normalizePhone==='function'?normalizePhone(w.movil||''):'';
      const digits=phone.replace(/\D/g,'');
      const phoneSvg='<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.8L7.1 10a16 16 0 0 0 6.9 6.9l1.5-1.9a2 2 0 0 1 1.8-.6l3 .5a2 2 0 0 1 1.7 2Z"/></svg>';
      const waSvg='<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a9 9 0 0 1-13.4 7.8L3 21l1.7-4.6A9 9 0 1 1 21 11.5Z"/><path d="M8.5 8.5c.4 3.4 3.1 6.1 6.5 6.5l1.5-1.5-2.4-1.3-1.1 1a7 7 0 0 1-2.7-2.7l1-1.1L10 7Z"/></svg>';
      const contacts=phone?'<div class="crew-return-contacts"><a href="tel:'+escapeAttr(phone)+'" title="Llamar a '+escapeAttr(w.personal)+'" aria-label="Llamar a '+escapeAttr(w.personal)+'">'+phoneSvg+'</a><a href="https://wa.me/'+digits+'" target="_blank" rel="noopener noreferrer" title="WhatsApp de '+escapeAttr(w.personal)+'" aria-label="WhatsApp de '+escapeAttr(w.personal)+'">'+waSvg+'</a></div>':'';
      return '<div class="crew-return-person" data-status="'+status+'">'+
        '<div class="crew-return-identity"><strong>'+escapeHtml(w.personal)+'</strong>'+
        '<span class="crew-return-details"><b>'+escapeHtml(teamName)+'</b> · '+escapeHtml(specialty)+'</span></div>'+
        '<div class="crew-return-right">'+contacts+'<span class="crew-return-status-label">'+LABELS[status]+'</span>'+
        '<div class="crew-return-picker"><span class="crew-return-toggle" aria-hidden="true">'+icon(status)+'</span>'+
        '<select class="crew-return-select" data-return-worker="'+escapeAttr(String(w.id))+'" aria-label="Estado de regreso de '+escapeAttr(w.personal)+'" '+(state.service.closed?'disabled ':'')+'>'+
        STATES.map(s=>'<option value="'+s+'" '+(s===status?'selected ':'')+'>'+LABELS[s]+'</option>').join('')+'</select></div></div></div>';
    }).join('');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});
  else initialize();
})();
