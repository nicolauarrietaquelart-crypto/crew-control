/* Crew Control — regreso de pausa por turno, independiente del estado de asistencia. */
(function(){
  'use strict';
  const STATES=['PENDIENTE','CONTACTADO','PRESENTE','NO PRESENTADO'];
  const LABELS={'PENDIENTE':'PENDIENTE','CONTACTADO':'CONTACTADO','PRESENTE':'PRESENTE','NO PRESENTADO':'NO PRESENTADO'};
  let activeShiftId='';
  let fromPeople=false;
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
  function openReturn(id){
    if(!state.service)return;
    const shift=crewPauseRecords().find(s=>s.id===id);
    if(!shift)return;
    fromPeople=!$('crewPausePeopleModal').classList.contains('hidden');
    activeShiftId=shift.id;
    $('crewPauseReturnTitle').textContent='Regreso de la pausa · '+shift.start+' – '+shift.end;
    $('crewPauseReturnSub').textContent=shift.trabajo+' · '+shift.serviceDate+' · Independiente de la asistencia general';
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
    crewPauseSave();  // D1 snapshot: turno concreto; no se modifica w.status.
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
      return '<div class="crew-return-person" data-status="'+status+'">'+
        '<div class="crew-return-identity"><strong>'+escapeHtml(w.personal)+'</strong>'+
        '<span class="crew-return-details"><b>'+escapeHtml(teamName)+'</b> · '+escapeHtml(specialty)+'</span></div>'+
        '<div class="crew-return-right"><span class="crew-return-status-label">'+LABELS[status]+'</span>'+
        '<div class="crew-return-picker"><span class="crew-return-toggle" aria-hidden="true">'+icon(status)+'</span>'+
        '<select class="crew-return-select" data-return-worker="'+escapeAttr(String(w.id))+'" aria-label="Estado de regreso de '+escapeAttr(w.personal)+'" '+(state.service.closed?'disabled ':'')+'>'+
        STATES.map(s=>'<option value="'+s+'" '+(s===status?'selected ':'')+'>'+LABELS[s]+'</option>').join('')+'</select></div></div></div>';
    }).join('');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});
  else initialize();
})();
