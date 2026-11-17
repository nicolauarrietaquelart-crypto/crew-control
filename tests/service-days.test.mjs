import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceWithoutDay} from '../src/manager.js';

test('manager deletes one closed day with its own references and preserves the other day',()=>{
 const oldDay='1/11/2026',otherDay='02/11/2026';
 const service={code:'123456',serviceDate:oldDay,closed:false,serviceName:'Evento',
  addedDays:[oldDay,otherDay],workers:[{id:'A',serviceDate:oldDay},{id:'B',serviceDate:otherDay}],
  requirements:[{serviceDate:oldDay},{serviceDate:otherDay}],
  incidents:[{serviceDate:oldDay,workerId:'A'},{serviceDate:otherDay,workerId:'B'}],
  blocks:[{id:'B1',serviceDate:oldDay},{id:'B2',serviceDate:otherDay}],
  pauseShifts:[{id:'P1',serviceDate:oldDay,workerIds:['A']},{id:'P2',serviceDate:otherDay,workerIds:['B']}],
  closedDays:{'01/11/2026':'closed'},pdfName:'original.pdf',pdfDocuments:{[oldDay]:'shared',[otherDay]:'shared'},
  staffingLinkedWorks:{[oldDay+'|LOCAL']:['TECNICA'],[otherDay+'|LOCAL']:['TECNICA']},
  _pauseVersions:{'shift:P1':1,'return:P1:A':2,['assignment:'+oldDay+':LOCAL:A']:3,'shift:P2':4}};
 const before=structuredClone(service);
 const result=serviceWithoutDay(service,'01/11/2026');
 assert.deepEqual(service,before);
 for(const field of ['workers','requirements','incidents','blocks','pauseShifts'])assert.deepEqual(result[field],[service[field][1]]);
 assert.deepEqual(result.closedDays,{});
 assert.deepEqual(result.pdfDocuments,{[otherDay]:'shared'});
 assert.equal(result.pdfName,'original.pdf');
 assert.deepEqual(result.staffingLinkedWorks,{[otherDay+'|LOCAL']:['TECNICA']});
 assert.deepEqual(result._pauseVersions,{'shift:P2':4});
 assert.equal(result.serviceDate,otherDay);
 assert.equal(result.code,'123456');
});

test('removing the final empty day preserves the service and its team structure',()=>{
 const service={code:'123456',serviceDate:'17/11/2026',addedDays:['17/11/2026'],workers:[],
  closed:true,teams:[{id:'T1'}],scenarios:[{id:'S1'}],pdfName:'old.pdf',pdfDocuments:{'17/11/2026':'PDF'}};
 const result=serviceWithoutDay(service,'17/11/2026');
 assert.deepEqual(result.addedDays,[]);
 assert.equal(result.serviceDate,'');
 assert.equal(result.pdfName,'');
 assert.deepEqual(result.pdfDocuments,{});
 assert.deepEqual(result.teams,service.teams);
 assert.equal(result.closed,true);
});

test('an unknown day cannot delete records or alter service metadata',()=>{
 const service={workers:[{id:'A',serviceDate:'17/11/2026'}]};
 assert.equal(serviceWithoutDay(service,'18/11/2026'),null);
 assert.equal(service.workers.length,1);
});
