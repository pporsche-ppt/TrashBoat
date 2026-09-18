const state = {
  token: localStorage.getItem('wiringAdminToken') || '',
  scanner: null,
  scannerActive: false,
  scanContext: null,
  bulk: { first: null, second: null, lastOperationId: null },
  deactivate: new Set(),
  formCode: null,
  formMode: null
};

const TAGS = ['Always ON', 'Disconnected', 'Normal ON', 'Normal OFF', 'Control'];

function el(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }
function isAdmin(){ return !!state.token; }
function authHeaders(){ return state.token ? {'Authorization':'Bearer '+state.token, 'Content-Type':'application/json'} : {'Content-Type':'application/json'}; }
async function api(url, options={}){
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', 'Bearer '+state.token);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  const r = await fetch(url, {...options, headers});
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {error:text}; }
  if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.data=data; e.status=r.status; throw e; }
  return data;
}
function setAdminUI(){
  el('adminState').textContent = isAdmin() ? 'Admin' : 'Viewer';
  el('loginBtn').classList.toggle('hidden', isAdmin());
  el('logoutBtn').classList.toggle('hidden', !isAdmin());
  document.querySelectorAll('.admin-only').forEach(x=>x.classList.toggle('hidden', !isAdmin()));
}
function show(view){
  if (['link','edit','bulk','deactivate','generate'].includes(view) && !isAdmin()) { login(); return; }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const target = el(view); if(target) target.classList.add('active');
  if(view==='database') loadDatabase();
  stopScanner();
}
function toast(message, type=''){
  const node=document.createElement('div'); node.className='notice '+type; node.textContent=message;
  document.querySelector('.view.active')?.prepend(node); setTimeout(()=>node.remove(),4500);
}

async function login(){
  const p = prompt('Admin password:'); if(p===null) return;
  try{
    const data = await api('/api/login',{method:'POST',body:JSON.stringify({password:p})});
    state.token=data.token; localStorage.setItem('wiringAdminToken', state.token); setAdminUI(); toast('Admin mode enabled.','good');
  }catch(e){ toast(e.message,'error'); }
}
function logout(){ state.token=''; localStorage.removeItem('wiringAdminToken'); setAdminUI(); toast('Logged out.'); }

function openScanner(context, onCode){
  state.scanContext=context; show('scan'); el('scanResult').innerHTML='';
  stopScanner();
  setTimeout(async()=>{
    try{
      state.scanner=new Html5Qrcode('reader');
      await state.scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:250,height:180}},(decoded)=>{ onCode(decoded.trim()); stopScanner(); });
      state.scannerActive=true;
    }catch(e){ el('scanResult').innerHTML='<div class="notice error">Camera could not start: '+esc(e.message)+'. Use the manual code field instead.</div>'; }
  },120);
}
async function stopScanner(){
  if(state.scanner){ try { if(state.scannerActive) await state.scanner.stop(); } catch{} try{ await state.scanner.clear(); }catch{} }
  state.scanner=null; state.scannerActive=false;
}
function validateScannedCode(code){ return /^\d{3}$/.test(code) ? code : null; }

async function scanView(code){
  code=validateScannedCode(code); if(!code){toast('QR must encode exactly three digits.','error');return;}
  try{ const data=await api('/api/qr/'+code); showRecord(data); }catch(e){ el('scanResult').innerHTML='<div class="notice error">'+esc(e.message)+'</div>'; }
}

function statusChip(s){ return `<span class="status-chip status-${esc(s)}">${esc(s)}</span>`; }
function recordHtml(data){
  const isDev=data.type==='DEVICE';
  let extra='';
  if(isDev){
    extra=`<div class="field" style="grid-column:1/-1"><label>Device Pins</label><div>${(data.pins||[]).map(p=>`<div class="pin-card"><b>${esc(p.pin_name)}</b><div class="muted">${esc(p.pin_description)}</div></div>`).join('') || '<span class="muted">No pins configured.</span>'}</div></div>`;
    extra+=`<div class="field" style="grid-column:1/-1"><label>Connected Cables</label><div>${(data.connected_cables||[]).map(c=>`<div class="pin-card"><b>Cable ${esc(c.cable_code)} · slot ${c.slot}</b><div class="muted">Pin: ${esc(c.endpoint_pin)} ${c.descriptive_text? '· '+esc(c.descriptive_text):''}</div></div>`).join('') || '<span class="muted">No cable connections.</span>'}</div></div>`;
  } else {
    extra=`<div class="field" style="grid-column:1/-1"><label>Connections</label><div>${[1,2].map(slot=>{const c=(data.connections||[]).find(x=>Number(x.slot)===slot); return `<div class="conn-card"><div class="conn-title">Connection ${slot}</div>${c?connectionDisplay(c):'<span class="muted">NOT CONNECTED</span>'}</div>`}).join('')}</div></div>`;
  }
  return `<div class="record-card"><div class="record-top"><div><div class="record-code">${esc(data.code)}</div><div class="muted">${esc(data.type)}</div></div><div>${statusChip(data.status)}</div></div><div class="record-grid"><div class="field"><label>Name</label><div class="value">${esc(data.name)||'—'}</div></div><div class="field"><label>Description tags</label><div class="value">${(data.description_tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')||'—'}</div></div><div class="field"><label>Operation Voltage</label><div class="value">${esc(data.operation_voltage)||'—'}</div></div><div class="field"><label>Bypass Protection Module</label><div class="value">${esc(data.bypass_protection)}</div></div><div class="field"><label>Emergency</label><div class="value">${esc(data.emergency)}</div></div><div class="field"><label>Details</label><div class="value">${esc(data.details)||'—'}</div></div>${extra}</div></div>`;
}
function connectionDisplay(c){
  if(c.endpoint_type==='TEXT') return `<div class="value">${esc(c.descriptive_text)}</div>`;
  if(c.endpoint_type==='CABLE') return `<div class="value">Cable QR: <b>${esc(c.endpoint_code)}</b>${c.descriptive_text?' · '+esc(c.descriptive_text):''}</div>`;
  return `<div class="value">Device QR: <b>${esc(c.endpoint_code)}</b> · Pin: <b>${esc(c.endpoint_pin)}</b>${c.descriptive_text?' · '+esc(c.descriptive_text):''}</div>`;
}
function showRecord(data){ show('record'); el('recordTitle').textContent=data.code; el('recordSubtitle').innerHTML=`${esc(data.type)} · ${statusChip(data.status)}`; el('recordBody').innerHTML=recordHtml(data); }

function renderTags(selected=[]){ return TAGS.map(t=>`<label style="display:inline-flex;flex-direction:row;align-items:center;gap:5px;margin-right:12px;font-weight:600"><input type="checkbox" class="tag-check" value="${esc(t)}" ${selected.includes(t)?'checked':''} style="width:auto">${esc(t)}</label>`).join(''); }
function baseForm(data, mode){
  const tags=data?.description_tags||[];
  const buttons=mode==='link'?'<button id="saveFormBtn">Link QR</button>':'<button id="saveFormBtn">Save changes</button>';
  const type=data.type;
  return `<div class="panel"><div class="form-grid two"><label>QR Code<input value="${esc(data.code)}" disabled></label><label>Type<input value="${esc(type)}" disabled></label><label>Name<input id="fName" value="${esc(data.name)}"></label><label>Operation Voltage<input id="fVoltage" placeholder="0/8V, 8V, 4/8V" value="${esc(data.operation_voltage)}"></label></div><div class="panel" style="margin-top:12px"><div class="form-section-title">Description tags</div><div>${renderTags(tags)}</div></div><div class="form-grid two"><label>Bypass Protection Module<select id="fBypass"><option>CUT</option><option>CONNECT</option><option>IGNORE</option></select></label><label>Emergency<select id="fEmergency"><option>CUT</option><option>CONNECT</option><option>IGNORE</option></select></label></div><label style="margin-top:12px">Details<textarea id="fDetails">${esc(data.details)}</textarea></label>${type==='CABLE'?cableConnectionsForm(data):devicePinsForm(data)}<div class="button-row">${buttons}<button class="secondary" id="cancelFormBtn">Cancel</button></div></div>`;
}
function cableConnectionsForm(data){
  const cons=[1,2].map(slot=>(data.connections||[]).find(c=>Number(c.slot)===slot)||{slot});
  return `<div class="panel" style="margin-top:12px"><div class="form-section-title">Connections</div><div>${cons.map(c=>connectionSlotForm(c)).join('')}</div></div>`;
}
function connectionSlotForm(c){
  return `<div class="connection-slot" data-slot="${c.slot}"><div class="slot-head"><b>Connection ${c.slot}</b></div><div class="inline"><label>Type<select class="conn-type"><option value="TEXT" ${c.endpoint_type==='TEXT'||!c.endpoint_type?'selected':''}>Descriptive text</option><option value="CABLE" ${c.endpoint_type==='CABLE'?'selected':''}>Cable QR</option><option value="DEVICE" ${c.endpoint_type==='DEVICE'?'selected':''}>Device QR</option></select></label><label>Code<input class="conn-code" inputmode="numeric" maxlength="3" value="${esc(c.endpoint_code||'')}" placeholder="scan or type"></label></div><div class="inline" style="margin-top:8px"><label>Device pin<input class="conn-pin" value="${esc(c.endpoint_pin||'')}" placeholder="required for device"></label><button type="button" class="secondary scan-slot" data-slot="${c.slot}">Scan QR</button></div><label style="margin-top:8px">Descriptive text<textarea class="conn-text" style="min-height:70px">${esc(c.descriptive_text||'')}</textarea></label><div class="muted slot-pin-help"></div></div>`;
}
function devicePinsForm(data){
  const pins=data.pins||[];
  return `<div class="panel" style="margin-top:12px"><div class="form-section-title">Device Pins</div><div id="pinsList">${pins.map(p=>pinRow(p)).join('')}</div><button type="button" class="secondary" id="addPinBtn">+ Add pin</button></div>`;
}
function pinRow(p={}){ return `<div class="pin-row"><input class="pin-name" placeholder="Pin name" value="${esc(p.pin_name||p.pinName||'')}"><input class="pin-desc" placeholder="Description" value="${esc(p.pin_description||p.pinDescription||'')}"><button type="button" class="secondary remove-pin">Remove</button></div>`; }
function collectForm(data){
  const result={name:el('fName').value,operationVoltage:el('fVoltage').value,details:el('fDetails').value,bypassProtection:el('fBypass').value,emergency:el('fEmergency').value,descriptionTags:[...document.querySelectorAll('.tag-check:checked')].map(x=>x.value)};
  if(data.type==='CABLE'){
    result.connections=[...document.querySelectorAll('.connection-slot')].map(box=>({slot:Number(box.dataset.slot),endpointType:box.querySelector('.conn-type').value,endpointCode:box.querySelector('.conn-code').value.trim(),endpointPin:box.querySelector('.conn-pin').value.trim(),descriptiveText:box.querySelector('.conn-text').value.trim()}));
  } else {
    result.pins=[...document.querySelectorAll('#pinsList .pin-row')].map(row=>({pinName:row.querySelector('.pin-name').value.trim(),pinDescription:row.querySelector('.pin-desc').value.trim()})).filter(p=>p.pinName);
  }
  return result;
}

async function openForm(code, mode){
  try{
    const data=await api('/api/qr/'+code);
    if(mode==='edit' && data.status==='READY'){ show('link'); await openForm(code,'link'); return; }
    if(mode==='link' && data.status!=='READY'){ throw new Error(`QR ${code} is ${data.status}, not READY.`); }
    if(mode==='edit' && data.status!=='ACTIVE'){ throw new Error(`QR ${code} is ${data.status}.`); }
    state.formCode=code; state.formMode=mode;
    const wrap=el(mode==='link'?'linkFormWrap':'editFormWrap'); wrap.innerHTML=baseForm(data,mode);
    el('fBypass').value=data.bypass_protection; el('fEmergency').value=data.emergency;
    el('saveFormBtn').onclick=async()=>saveForm(data);
    el('cancelFormBtn').onclick=()=>{wrap.innerHTML='';state.formCode=null};
    if(data.type==='DEVICE'){
      el('addPinBtn')?.addEventListener('click',()=>el('pinsList').insertAdjacentHTML('beforeend',pinRow()));
      bindPinRemovers();
    }
    if(data.type==='CABLE') bindConnectionUI();
  }catch(e){ toast(e.message,'error'); }
}
function bindPinRemovers(){document.querySelectorAll('.remove-pin').forEach(b=>b.onclick=()=>b.parentElement.remove());}
function bindConnectionUI(){
  document.querySelectorAll('.conn-type').forEach(sel=>sel.onchange=()=>refreshAllDevicePinHelps());
  document.querySelectorAll('.scan-slot').forEach(btn=>btn.onclick=async()=>{
    const slot=btn.dataset.slot;
    openScanner('slot', async(code)=>{
      const input=document.querySelector(`.connection-slot[data-slot="${slot}"] .conn-code`); input.value=code;
      const type=document.querySelector(`.connection-slot[data-slot="${slot}"] .conn-type`); type.value=isDeviceCode(code)?'DEVICE':'CABLE'; await refreshSlotPinHelp(slot);
    });
  });
}
function isDeviceCode(code){return /^3\d{2}$/.test(code)}
async function refreshAllDevicePinHelps(){for(const slot of [1,2]) await refreshSlotPinHelp(slot);}
async function refreshSlotPinHelp(slot){
  const box=document.querySelector(`.connection-slot[data-slot="${slot}"]`); if(!box)return;
  const type=box.querySelector('.conn-type').value, code=box.querySelector('.conn-code').value.trim(), help=box.querySelector('.slot-pin-help'), pin=box.querySelector('.conn-pin');
  if(type!=='DEVICE' || !/^\d{3}$/.test(code)){help.textContent='';return;}
  try{const pins=await api('/api/device/'+code+'/pins');help.textContent='Pins: '+(pins.map(p=>p.pin_name).join(', ')||'none');}catch(e){help.textContent=e.message;}
}
async function saveForm(data){
  try{
    const payload=collectForm(data); const code=data.code;
    const endpoint=state.formMode==='link'?'/api/qr/link':'/api/qr/'+code;
    const body={...payload,code};
    const updated=await api(endpoint,{method:state.formMode==='link'?'POST':'PUT',body:JSON.stringify(body)});
    toast(state.formMode==='link'?'QR linked successfully.':'QR updated successfully.','good');
    const wrap=el(state.formMode==='link'?'linkFormWrap':'editFormWrap'); wrap.innerHTML=''; showRecord(updated);
  }catch(e){toast(e.message,'error');}
}

function bindHome(){document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.action; if(a==='scan'){openScanner('view',scanView)}else if(a==='link'){show('link');el('linkScanBtn').onclick=()=>openScanner('link',code=>{show('link');openForm(code,'link')})}else if(a==='edit'){show('edit');el('editScanBtn').onclick=()=>openScanner('edit',code=>{show('edit');openForm(code,'edit')})}else show(a);});}

async function startBulk(){
  state.bulk={first:null,second:null,lastOperationId:null};
  el('bulkUndoBtn').classList.add('hidden'); el('bulkPinWrap').innerHTML='';
  el('bulkStatus').textContent='Scan the first QR code.';
  openScanner('bulk-first', code=>handleBulkCode(code));
}
async function handleBulkCode(code){
  code=validateScannedCode(code); if(!code){toast('QR must encode exactly three digits.','error'); return;}
  const type=isDeviceCode(code)?'DEVICE':(isCableCode(code)?'CABLE':null);
  if(!type){toast('Supported codes are 100–299 for cable or 300–999 for device.','error');return;}
  if(!state.bulk.first){state.bulk.first={code,type};el('bulkStatus').innerHTML=`First: <b>${code}</b> (${type}). Scan the second QR code.`;openScanner('bulk-second',handleBulkCode);return;}
  if(state.bulk.first.code===code){toast('Scan a different QR code.','error');openScanner('bulk-second',handleBulkCode);return;}
  state.bulk.second={code,type};
  if(type==='DEVICE' && state.bulk.first.type==='DEVICE'){el('bulkStatus').textContent='Device-to-device is not allowed.';return;}
  if(state.bulk.first.type==='DEVICE' || type==='DEVICE'){
    const device=state.bulk.first.type==='DEVICE'?state.bulk.first.code:code;
    const pins=await api('/api/device/'+device+'/pins').catch(()=>[]);
    el('bulkPinWrap').innerHTML=`<div class="panel"><label>Select device pin<select id="bulkPin"></select></label><button id="bulkLinkBtn" style="margin-top:10px">Link</button></div>`;
    if(Array.isArray(pins)) el('bulkPin').innerHTML=pins.map(p=>`<option>${esc(p.pin_name)}</option>`).join('');
    el('bulkLinkBtn').onclick=()=>performBulkLink();
    el('bulkStatus').textContent=`Ready: ${state.bulk.first.code} ↔ ${code}`;
  } else { await performBulkLink(); }
}
function isCableCode(code){return /^\d{3}$/.test(code)&&Number(code)>=100&&Number(code)<=299;}
async function performBulkLink(){
  try{
    const pin=el('bulkPin')?.value||''; const data=await api('/api/connections/bulk',{method:'POST',body:JSON.stringify({first:state.bulk.first.code,second:state.bulk.second.code,pin})});
    state.bulk.lastOperationId=data.operationId; el('bulkUndoBtn').classList.remove('hidden'); el('bulkStatus').textContent='Linked successfully.'; el('bulkLast').innerHTML=`<div class="notice good">Linked ${esc(state.bulk.first.code)} with ${esc(state.bulk.second.code)}.<br><button id="bulkNextBtn" class="secondary">Link another pair</button></div>`; el('bulkNextBtn').onclick=startBulk;
  }catch(e){el('bulkStatus').textContent=e.message;}
}
async function undoBulk(){
  if(!state.bulk.lastOperationId)return;
  try{await api('/api/connections/undo/'+state.bulk.lastOperationId,{method:'POST'});toast('Last bulk link undone.','good');state.bulk.lastOperationId=null;el('bulkUndoBtn').classList.add('hidden');el('bulkStatus').textContent='Undone.';}catch(e){toast(e.message,'error');}
}

function deactivateScan(){openScanner('deactivate',async(code)=>{code=validateScannedCode(code);if(!code){toast('Invalid code','error');return;}try{const d=await api('/api/qr/'+code);state.deactivate.add(code);renderDeactivateList();toast(`${code} added (${d.status}).`,'good');}catch(e){toast(e.message,'error');} });}
function renderDeactivateList(){const wrap=el('deactivateList');wrap.innerHTML=[...state.deactivate].map(code=>`<label class="check-row"><input type="checkbox" checked data-deact="${code}"><span><b>${code}</b></span></label>`).join('')||'<div class="muted">No scanned QR codes yet.</div>';}
function selectedDeact(){return [...document.querySelectorAll('[data-deact]:checked')].map(x=>x.dataset.deact);}
async function bulkAction(kind){const codes=selectedDeact();if(!codes.length){toast('Select at least one code.','error');return;}try{const endpoint=kind==='deactivate'?'/api/qr/bulk-deactivate':'/api/qr/bulk-clear';const data=await api(endpoint,{method:'POST',body:JSON.stringify({codes})});toast(kind==='deactivate'?`Deactivated: ${data.deactivated.join(', ')}`:`Cleared: ${data.cleared.join(', ')}`,'good');state.deactivate.clear();renderDeactivateList();}catch(e){toast(e.message,'error');}}

async function generate(){
  try{const data=await api('/api/generate',{method:'POST',body:JSON.stringify({cableAmount:Number(el('cableAmount').value),deviceAmount:Number(el('deviceAmount').value)})});
    const codes=data.created.map(x=>x.code); el('generateResult').innerHTML=`<div class="notice good">Generated ${codes.length} QR codes.</div><div class="panel"><div class="muted">${codes.join(', ')}</div><button id="printGenerated" style="margin-top:10px">Print labels</button></div>`;el('printGenerated').onclick=()=>window.open('/print-labels?codes='+encodeURIComponent(codes.join(',')),'_blank');
  }catch(e){toast(e.message,'error');}
}

async function loadDatabase(){
  try{const type=el('dbType').value,status=el('dbStatus').value;const qs=new URLSearchParams();if(type)qs.set('type',type);if(status)qs.set('status',status);const rows=await api('/api/qr?'+qs.toString());el('dbTableWrap').innerHTML=`<table class="data-table"><thead><tr><th>Code</th><th>Type</th><th>Status</th><th>Name</th><th>Tags</th><th>Voltage</th></tr></thead><tbody>${rows.map(r=>`<tr><td><button class="secondary db-code" data-code="${r.code}">${r.code}</button></td><td>${esc(r.type)}</td><td>${statusChip(r.status)}</td><td>${esc(r.name)}</td><td>${esc((r.description_tags||[]).join(', '))}</td><td>${esc(r.operation_voltage)}</td></tr>`).join('')||'<tr><td colspan="6">No records.</td></tr>'}</tbody></table>`;document.querySelectorAll('.db-code').forEach(b=>b.onclick=()=>api('/api/qr/'+b.dataset.code).then(showRecord));
  }catch(e){toast(e.message,'error');}
}

function init(){
  setAdminUI();bindHome();
  el('loginBtn').onclick=login;el('logoutBtn').onclick=logout;
  document.querySelectorAll('.back').forEach(b=>b.onclick=()=>show(b.dataset.go||'home'));
  el('manualScanBtn').onclick=()=>scanView(el('manualScan').value.trim());
  el('linkScanBtn').onclick=()=>openScanner('link',code=>{show('link');openForm(code,'link')});
  el('editScanBtn').onclick=()=>openScanner('edit',code=>{show('edit');openForm(code,'edit')});
  el('bulkStartBtn').onclick=startBulk;el('bulkUndoBtn').onclick=undoBulk;el('deactivateScanBtn').onclick=deactivateScan;el('deactivateBtn').onclick=()=>bulkAction('deactivate');el('clearBtn').onclick=()=>bulkAction('clear');el('generateBtn').onclick=generate;el('dbRefresh').onclick=loadDatabase;el('dbType').onchange=loadDatabase;el('dbStatus').onchange=loadDatabase;
  renderDeactivateList();
}
init();
