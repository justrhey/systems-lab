const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state, project, config, selected = 'gateway', inspected = 'api', view = 'infra', dirty = false, acting = false, oldTarget = 'project';
let localProjects = [], catalogLoaded = false, workloads = {}, workloadsLoaded = false;
let renderedObservation = '';
function automaticWorkload() { return state?.observations?.[config?.projectPath]; }
function readWorkload() {
  const values = Object.fromEntries([...document.querySelectorAll('[data-workload]')].map(input => [input.dataset.workload, input.dataset.custom === 'true' ? input.value.trim() : '']));
  workloads[config.projectPath] = values;
  const custom = Object.values(values).filter(Boolean).length;
  const measured = Object.keys(automaticWorkload()?.fields || {}).filter(key => !values[key]).length;
  $('#workload-completeness').textContent = `${measured} automatic · ${custom} customized`;
  return values;
}
function renderWorkload() {
  const values = workloads[config.projectPath] || {}, observation = automaticWorkload(), automatic = observation?.fields || {};
  document.querySelectorAll('[data-workload]').forEach(input => {
    const key = input.dataset.workload, custom = Boolean(values[key]);
    input.value = values[key] || automatic[key] || '';
    input.dataset.custom = String(custom); input.readOnly = true;
    const source = document.querySelector(`[data-workload-source="${key}"]`);
    source.textContent = custom ? 'Your custom value' : automatic[key] ? (['p50','p95','p99'].includes(key) ? 'Automatic: measured response time. Customize to set your goal.' : 'Automatic: latest project test') : (['averageRps','peakRps','readWriteRatio','requestSize','responseSize','p50','p95','p99','burstShape'].includes(key) ? 'No measurement available yet. Run a project test or enter a custom value.' : key === 'datasetSize' ? 'Available when the lab database size can be read.' : 'Add your plan when you know it; a local test cannot determine this.');
    document.querySelector(`[data-edit-workload="${key}"]`).textContent = 'Edit';
    document.querySelector(`[data-reset-workload="${key}"]`).hidden = !custom;
  });
  const demo = state?.observations?.__demo__;
  $('#baseline-summary').textContent = observation
    ? `Filled from the project test on ${new Date(observation.id).toLocaleString()}: ${Number(observation.requests).toLocaleString()} requests, ${Number(observation.failureRate).toFixed(1)}% failed. Result: ${observation.status}. You can edit any value below.`
    : demo ? 'A demo test is available, but it describes the sandbox. Run a Project stack test to fill this project’s values automatically.' : 'No test yet. Start your app and run a test; the lab will fill in what it can measure. You can leave everything else blank.';
  readWorkload(); $('#workload-save-state').textContent = 'Automatic measurements are saved after each run. Your custom values are saved separately.';
  renderedObservation = `${config.projectPath}:${observation?.id || ''}:${state?.observations?.__demo__?.id || ''}`;
}
async function saveWorkload() {
  if (!workloadsLoaded) return;
  await api('/api/workload', {projectPath: config.projectPath, requirements: readWorkload()});
  $('#workload-save-state').textContent = `Custom values saved for ${projectName()}.`;
}
async function loadWorkloads() {
  workloads = await api('/api/workloads'); workloadsLoaded = true; document.querySelectorAll('[data-workload]').forEach(input => { input.disabled = false; }); renderWorkload(); renderButtons();
}
function projectName() { return config?.projectPath.split('/').filter(Boolean).at(-1) || 'Local project'; }
function syncProjectLabels() {
  const item = localProjects.find(p => p.path === config.projectPath);
  const name = item?.name || projectName();
  $('#project-picker-name').textContent = name;
  $('#workspace-project-name').textContent = name;
  $('#breadcrumb-project').textContent = name;
  descriptions.infra[1] = `A private test environment for ${name}. Everything runs locally.`;
  if (view === 'infra') $('#page-description').textContent = descriptions.infra[1];
  $('#profile-name').textContent = config.mode === 'detected' ? 'Detected services' : config.mode === 'freshphones' ? 'Legacy stack' : 'Dockerfile project';
  $('#custom-fields').classList.toggle('hidden', config.mode !== 'custom');
  $('#project-dockerfiles').innerHTML = (item?.dockerfiles || []).map(file => `<option value="${esc(file)}"></option>`).join('');
  $('#project-setup-hint').textContent = item && !item.ready
    ? 'Dockerfile needed. This project is selectable; add a Dockerfile in its folder or enter an existing relative Dockerfile path below before preparing its stack.'
    : config.mode === 'detected' ? 'Services come from systems-lab.json when present, otherwise from a bounded code scan. Review detected dependencies and runtime settings before starting.' : config.mode === 'freshphones' ? 'Legacy profile. Choose Detected services to use project files.' : 'Set the Dockerfile and its HTTP port. The server must listen on 0.0.0.0 inside the container. Customize the project k6 journey for its routes.';
  document.querySelectorAll('[data-profile]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.profile === config.mode)));
}
function closeProjectMenus(focus) {
  closeChoice();
  for (const [trigger, panel] of [['#project-picker','#project-picker-panel'],['#profile-picker','#profile-options']]) {
    $(trigger).setAttribute('aria-expanded','false'); $(panel).classList.add('hidden');
  }
  if (focus) $(focus).focus();
}
function renderProjectOptions() {
  const query = $('#project-search').value.trim().toLowerCase();
  const choices = localProjects.filter(p => `${p.name} ${p.path} ${p.group}`.toLowerCase().includes(query));
  $('#project-options').innerHTML = choices.length ? choices.map(p => `<button type="button" role="option" aria-selected="${p.path === config.projectPath}" data-project-path="${esc(p.path)}"><span class="project-option-title">${esc(p.name)}<span class="project-readiness">${p.mode === 'freshphones' ? 'Full stack' : p.ready ? 'Dockerfile' : 'Setup needed'}</span></span><small>${esc(p.group)} · ${esc(p.path)}</small></button>`).join('') : `<p class="dropdown-empty">${catalogLoaded ? 'No matching projects. Choose another folder below.' : 'Loading projects…'}</p>`;
}
async function loadProjects() {
  const catalog = await api('/api/projects');
  localProjects = catalog.projects; catalogLoaded = true;
  renderProjectOptions(); syncProjectLabels(); if ($('#project-picker').getAttribute('aria-expanded') === 'true') positionDropdown('#project-picker','#project-picker-panel');
}
function positionDropdown(trigger, panel) {
  const rect = $(trigger).getBoundingClientRect(), menu = $(panel);
  const width = Math.min(panel === '#profile-options' ? 320 : 480,innerWidth-32);
  menu.style.width = `${width}px`;
  const height = Math.min(menu.scrollHeight,400,innerHeight-32);
  menu.style.left = `${Math.max(16,Math.min(rect.left,innerWidth-width-16))}px`;
  menu.style.top = `${Math.max(16,Math.min(rect.bottom+8,innerHeight-height-16))}px`;
  menu.style.maxHeight = `${Math.min(400,innerHeight-32)}px`; menu.style.overflowY = 'auto';
}
async function openProjectPicker() {
  const open = $('#project-picker').getAttribute('aria-expanded') !== 'true';
  closeProjectMenus();
  if (!open) return;
  $('#project-picker').setAttribute('aria-expanded','true'); $('#project-picker-panel').classList.remove('hidden');
  $('#project-search').value = ''; renderProjectOptions(); positionDropdown('#project-picker','#project-picker-panel'); $('#project-search').focus();
  try { await loadProjects(); } catch (error) { $('#project-options').innerHTML = `<p class="dropdown-empty">${esc(error.message)}. Enter a folder manually or reopen to retry.</p>`; }
}
async function chooseLocalProject(path) {
  const next = localProjects.find(p => p.path === path); if (!next) return;
  rememberEditors(); readInspector(); if (workloadsLoaded) await saveWorkload();
  rememberPlan();
  const previousPath = config.projectPath;
  project.projectJourneys ??= {};
  project.projectJourneys[previousPath] = project.freshScenario;
  if (previousPath !== next.path) {
    project.freshScenario = project.projectJourneys[next.path] || `import http from 'k6/http';
import { check, sleep } from 'k6';
export const options = {
  stages: [
    { duration: __ENV.RAMP + 's', target: Number(__ENV.USERS) },
    { duration: __ENV.DURATION + 's', target: Number(__ENV.USERS) },
    { duration: '3s', target: 0 },
  ],
  thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<1000'] },
};
export default function() {
  const response = http.get(__ENV.TARGET + '/');
  check(response, { 'homepage succeeds': r => r.status >= 200 && r.status < 400 });
  sleep(0.5 + Math.random());
}
`;
  }
  $('#run-target').value = 'project'; updateScenario();
  config.projectPath = next.path; config.mode = 'detected'; delete config.definition;
  await detectProject();
  const nextPlan=project.environmentPlans?.[next.path];config.plan=nextPlan?structuredClone(nextPlan):{preset:'standard',cpu:2,ram:4096,allocation:'automatic',billing:{model:'estimate',price:0,credit:0}};config.storageGB=nextPlan?.storageGB||20;
  renderWorkload();
  config.dockerfile = next.dockerfiles[0] || 'Dockerfile'; config.appPort = next.appPort || 3000;
  $('#project-path').value = config.projectPath; $('#project-mode').value = config.mode;
  $('#dockerfile').value = config.dockerfile; $('#app-port').value = config.appPort;
  if (config.mode === 'custom' && ['api','worker'].includes(inspected)) inspected = 'web';
  syncProjectLabels(); renderResources(); renderInfraLive(); renderButtons(); closeProjectMenus('#project-picker'); markDirty();
  notice(`${next.name} selected. Review the profile, Dockerfile, HTTP port, and k6 journey, then prepare the stack. Existing project stacks and volumes are retained.`);
}
function dependencyWarning(id) {
  const users=Object.entries(config.definition?.services||{}).filter(([key,s])=>config.resources[key]?.enabled && (s.dependsOn||[]).includes(id)).map(([key])=>key);
  return users.length?`Used by ${users.join(', ')}. Removing this service may cause requests or jobs to fail.`:'';
}
let inspectionSource='';
async function detectProject(rescan=false) {
  const folder=config.projectPath;
  let result;
  try{result=await api(`/api/project/inspect?path=${encodeURIComponent(folder)}${rescan?'&scan=true':''}`);}catch(error){
    config.mode='detected';config.definition={version:1,entry:null,services:{}};
    for(const r of Object.values(config.resources))r.enabled=false;
    inspected='web';$('#project-mode').value='detected';$('#detection-status').textContent=`Could not read project services: ${error.message}. Fix systems-lab.json or rescan the code.`;
    renderResources();syncProjectLabels();throw error;
  }
  if(config.projectPath!==folder)return;
  const previous=config.definition;
  let def=result.definition;
  if(rescan && previous){
    // Keep explicit runtime settings and removals; refresh evidence and add newly found services.
    for(const [id,s] of Object.entries(previous.services)){
      if(def.services[id])def.services[id]={...def.services[id],...s,evidence:def.services[id].evidence};
      else def.services[id]=s;
    }
    def={...previous,services:def.services};
  }
  config.mode='detected';config.definition=def;
  for(const [id,r] of Object.entries(config.resources)){if(!Object.hasOwn(planWeights,id)&&!def.services[id])delete config.resources[id];else r.enabled=false;}
  for(const [id,s] of Object.entries(def.services)){
    config.resources[id]??={cpu:1,ram:512,enabled:false};config.resources[id].enabled=s.enabled!==false;
    const base=serviceInfo[id]||[id,s.kind==='app'?'Application':'Infrastructure','Configured by this project.'];
    if(s.kind==='app')serviceInfo[id]=[esc(s.label||id),esc(s.role||'Application service'),'Runs the Dockerfile and command recorded in systems-lab.json.'];
    else serviceInfo[id]=base;
  }
  inspected=Object.keys(def.services).find(id=>config.resources[id].enabled)||'web';
  inspectionSource=result.source;
  $('#project-mode').value='detected';
  $('#detection-status').textContent=`${result.source==='project-file'?'Loaded systems-lab.json':'Scanned code; project file not saved yet'} · ${Object.values(def.services).filter(s=>s.enabled!==false).length} included services. ${(result.warnings||[]).join(' ')}`;
  syncProjectLabels();renderResources();
}
$('#rescan-project').onclick=()=>action(async()=>{config.projectPath=$('#project-path').value.trim();await detectProject(true);markDirty();},'Code scan complete. Your existing runtime settings and removals were kept.');
$('#save-project-file').onclick=()=>action(async()=>{
  if(config.mode!=='detected'||!config.definition)throw new Error('Detect services first.');
  readInspector();
  for(const [id,s] of Object.entries(config.definition.services))s.enabled=Boolean(config.resources[id]?.enabled);
  await api('/api/project/manifest',{projectPath:config.projectPath,definition:config.definition});
  $('#detection-status').textContent='Saved systems-lab.json in this project. Removals and custom settings will be reused.';
},'Project file saved. Prepare and start to apply runtime changes.');
// Keep the original form values/events, with one shared visual and keyboard menu.
const choiceControls = new Map();
let openChoice = null;
function closeChoice(restoreFocus = false) {
  if (!openChoice) return;
  const control = openChoice; openChoice = null;
  control.menu.hidden = true;
  control.owner.setAttribute('aria-expanded', 'false');
  control.owner.removeAttribute('aria-activedescendant');
  if (restoreFocus) control.owner.focus();
}
function syncChoices() { choiceControls.forEach(control => control.sync()); }
function upgradeChoices() {
  const fields = [...document.querySelectorAll('select'), ...document.querySelectorAll('input[list]')];
  for (const field of fields) {
    if (choiceControls.has(field)) continue;
    const editable = field.tagName === 'INPUT';
    const source = editable ? document.getElementById(field.getAttribute('list')) : field;
    if (!source) continue;
    const caption = field.getAttribute('aria-label') || [...(field.closest('label')?.childNodes || [])].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).join(' ').trim() || 'Choose an option';
    const wrapper = document.createElement('span'); wrapper.className = `choice-control${editable ? ' choice-editable' : ''}`;
    field.before(wrapper); wrapper.append(field);
    const button = document.createElement('button'); button.type = 'button'; button.id = `${field.id}-trigger`; button.className = 'choice-trigger';
    button.innerHTML = `${editable ? '' : '<span class="choice-value"></span>'}<svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    wrapper.append(button);
    const owner = editable ? field : button;
    const menu = document.createElement('div'); menu.id = `${field.id}-menu`; menu.className = 'select-menu'; menu.hidden = true;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', caption); (field.closest('dialog') || document.body).append(menu);
    owner.setAttribute('role', 'combobox'); owner.setAttribute('aria-haspopup', 'listbox'); owner.setAttribute('aria-expanded', 'false'); owner.setAttribute('aria-controls', menu.id);
    if (editable) { field.removeAttribute('list'); field.setAttribute('aria-autocomplete','list'); button.tabIndex = -1; button.setAttribute('aria-label', `Show options for ${caption}`); }
    else { field.hidden = true; field.tabIndex = -1; field.setAttribute('aria-hidden','true'); }
    let options = [], active = -1, signature = '', query = '', typeAhead = '', typedAt = 0;
    const control = {field, owner, menu, sync}; choiceControls.set(field, control);
    function available() { return options.map((option,index)=>({option,index})).filter(({option})=>!option.disabled && (!query || option.label.toLowerCase().includes(query))); }
    function highlight(index, scroll = true) {
      active = index;
      menu.querySelectorAll('[role=option]').forEach(row=>row.classList.toggle('is-active',Number(row.dataset.index)===active));
      const row = document.getElementById(`${field.id}-option-${index}`);
      if (row) { owner.setAttribute('aria-activedescendant',row.id); if(scroll) row.scrollIntoView({block:'nearest'}); }
      else owner.removeAttribute('aria-activedescendant');
    }
    function render() {
      const visible = available();
      menu.innerHTML = visible.length ? visible.map(({option,index})=>`<div id="${field.id}-option-${index}" class="select-option" role="option" aria-selected="${option.value===field.value}" data-index="${index}"><span>${esc(option.label)}</span><span class="choice-check" aria-hidden="true">${option.value===field.value?'✓':''}</span></div>`).join('') : '<div class="select-empty">No matching options. You can type your own value.</div>';
      highlight(active,false);
    }
    function position() {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width,Math.min(340,Math.max(...options.map(option=>option.label.length*7+56),180))),innerWidth-32);
      menu.style.width = `${width}px`;
      const naturalHeight = Math.min(menu.scrollHeight,300,innerHeight-32);
      const below = innerHeight-rect.bottom-12, above=rect.top-12;
      const top = below<naturalHeight && above>below ? rect.top-naturalHeight-6 : rect.bottom+6;
      menu.style.left = `${Math.max(16,Math.min(rect.left,innerWidth-width-16))}px`;
      menu.style.top = `${Math.max(16,Math.min(top,innerHeight-naturalHeight-16))}px`;
      menu.style.maxHeight = `${Math.min(300,innerHeight-32)}px`;
    }
    function sync() {
      options = [...source.options].map(option=>({value:option.value,label:option.label || option.textContent || option.value,disabled:option.disabled}));
      const next = JSON.stringify(options);
      const selected = options.find(option=>option.value===field.value);
      if (!editable) {
        const text = selected?.label || (options.length ? 'Choose…' : 'No options');
        if(button.querySelector('.choice-value').textContent!==text) button.querySelector('.choice-value').textContent=text;
        owner.setAttribute('aria-label',`${caption}: ${text}`);
        button.disabled = !state || field.disabled || !options.some(option=>!option.disabled);
      } else button.disabled = !state || field.disabled || !options.some(option=>!option.disabled);
      if (openChoice===control && field.disabled) closeChoice();
      if (openChoice===control && next!==signature) { render();position(); }
      signature=next;
      if(openChoice===control) menu.querySelectorAll('[role=option]').forEach(row=>{ const selected=options[Number(row.dataset.index)]?.value===field.value; row.setAttribute('aria-selected',String(selected));row.querySelector('.choice-check').textContent=selected?'✓':''; });
    }
    function open(filter = '') {
      if (!state || field.disabled || (!editable && button.disabled)) return;
      closeProjectMenus(); query=filter; sync();
      openChoice=control; menu.hidden=false; owner.setAttribute('aria-expanded','true');
      active=options.findIndex(option=>option.value===field.value&&!option.disabled);
      if(!available().some(item=>item.index===active)) active=available()[0]?.index ?? -1;
      render();position();highlight(active);owner.focus();
    }
    function choose(index, focus = true) {
      const option=options[index]; if(!option || option.disabled)return;
      field.value=option.value; field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
      sync();closeChoice(focus);
    }
    button.onclick=event=>{event.preventDefault(); if(openChoice===control)closeChoice(true);else open();};
    menu.onpointerdown=event=>event.preventDefault();
    menu.onclick=event=>{const row=event.target.closest('[data-index]');if(row)choose(Number(row.dataset.index));};
    owner.addEventListener('keydown',event=>{
      const expanded=openChoice===control;
      if(event.key==='Tab'){if(expanded){if(active>=0)choose(active,false);else closeChoice();}return;}
      if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();closeChoice(true);return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();if(!expanded){open();if(event.key==='ArrowDown'||event.key==='ArrowUp')return;}
        const choices=available(),current=choices.findIndex(item=>item.index===active);
        const next=event.key==='Home'?0:event.key==='End'?choices.length-1:(current+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
        highlight(choices[next]?.index??-1);return;
      }
      if(event.key==='Enter'||(!editable&&event.key===' ')){event.preventDefault();if(expanded)choose(active);else open();return;}
      if(!editable&&event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
        event.preventDefault();const now=Date.now();typeAhead=now-typedAt>700?event.key.toLowerCase():typeAhead+event.key.toLowerCase();typedAt=now;
        if(!expanded)open();const found=options.findIndex(option=>!option.disabled&&option.label.toLowerCase().startsWith(typeAhead));if(found>=0)highlight(found);
      }
    });
    field.addEventListener('change',sync);
    if(editable)field.addEventListener('input',()=>{if(!options.length)return;if(openChoice!==control)open(field.value.toLowerCase());else{query=field.value.toLowerCase();active=available()[0]?.index??-1;render();position();}});
    new MutationObserver(sync).observe(source,{childList:true,subtree:true,characterData:true,attributes:true});
    sync();
  }
  document.addEventListener('pointerdown',event=>{if(openChoice&&!event.target.closest('.choice-control,.select-menu'))closeChoice();});
  document.addEventListener('focusin',event=>{if(openChoice&&event.target!==openChoice.owner&&!openChoice.menu.contains(event.target))closeChoice();});
  document.addEventListener('scroll',event=>{if(event.target instanceof Element && event.target.closest('.select-menu,.dropdown-panel'))return;closeProjectMenus();},true);
}

let terminalPaused = false, terminalVisible = [], terminalSignature = '', resultsLayout = 'split';
function issueKind(line) {
  const message = line.message || '';
  if (/timeout|timed out|deadline|aborted due to timeout/i.test(message)) return 'Request timed out';
  if (/threshold/i.test(message)) return 'Test limits exceeded';
  if (/ECONNREFUSED|offline|cannot connect|connection refused/i.test(message)) return 'Connection unavailable';
  if (/Injected network failure|Network link disconnected/i.test(message)) return 'Simulated connection fault';
  if (/error|exception|failed|→ [45]\d\d/i.test(message)) return 'Request or service error';
  return null;
}
function setResultsLayout(mode) {
  resultsLayout = mode; $('#logs-view').dataset.resultsLayout = mode;
  document.querySelectorAll('button[data-results-layout]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.resultsLayout === mode)));
}
function renderResults() {
  const run = state.run, m = state.metrics, active = ['running','stopping'].includes(run.status), hasRun = run.status !== 'idle';
  const requests = Math.round(m.requests), failed = Math.round(m.failed), success = Math.max(0,requests-failed);
  const title = !hasRun ? 'No test yet' : active ? 'Test in progress' : run.status === 'passed' ? 'Test passed its limits' : run.status === 'stopped' ? 'Test stopped' : 'Test finished with problems';
  $('#result-heading').textContent = title; $('#result-state').textContent = active ? 'Running' : hasRun ? run.status : 'Ready';
  const target = run.target === 'project' ? run.projectPath?.split('/').filter(Boolean).at(-1) || 'Project stack' : 'Code sandbox';
  const elapsed = hasRun ? ((run.finished || Date.now())-run.started)/1000 : 0;
  $('#results-context').textContent = hasRun ? `${target} · ${Number(run.users).toLocaleString()} configured users · ${elapsed.toFixed(1)}s elapsed · ${elapsed > 0 ? (requests/elapsed).toFixed(1) : '0.0'} average requests/s` : 'Start your app, choose a target, then run a test.';
  $('#result-explanation').textContent = !hasRun ? 'The results summary and terminal will update here. A completed test shows 0 active users because it has finished.' : active ? 'Requests are still being collected. The final result is available after the test finishes.' : run.status === 'passed' ? 'The configured test limits passed for this run. This is evidence for this workload, not a guarantee about every future load.' : run.status === 'stopped' ? 'The test was stopped. These are the partial measurements collected before it ended.' : `This run recorded ${failed.toLocaleString()} failed requests (${m.failureRate.toFixed(1)}%). ${run.status === 'thresholds failed' ? 'One or more limits in the test script were exceeded.' : 'Inspect the output to understand why the run ended.'}`;
  $('#result-totals').innerHTML = `<div><small>Successful requests</small><strong>${success.toLocaleString()}</strong></div><div><small>Failed requests</small><strong>${failed.toLocaleString()}</strong></div><div><small>Total requests</small><strong>${requests.toLocaleString()}</strong></div><p class="result-checks">${m.checks ? `${Number(m.passed).toLocaleString()} / ${Number(m.checks).toLocaleString()} checks passed` : 'No test checks reported'}</p>`;
  const bars = $('#result-request-bar').children;
  bars[0].style.width = `${requests ? success/requests*100 : 0}%`; bars[1].style.width = `${requests ? failed/requests*100 : 0}%`;
  const max = Math.max(m.p50 || 0,m.p95 || 0,m.p99 || 0,1);
  $('#result-latencies').innerHTML = [['p50','Typical'],['p95','Slow'],['p99','Slowest']].map(([key,label]) => `<div class="latency-row"><span>${label} <small>${key}</small></span><span class="latency-track"><span style="width:${m.samples ? (m[key] || 0)/max*100 : 0}%"></span></span><strong>${m.samples ? `${Number(m[key] || 0).toLocaleString(undefined,{maximumFractionDigits:1})} ms` : '—'}</strong></div>`).join('');
  const groups = new Map();
  for (const line of state.logs) { const kind = issueKind(line); if (!kind) continue; const key = `${line.service}:${kind}`; const current = groups.get(key) || {kind,service:line.service,count:0}; current.count++; groups.set(key,current); }
  const issues = [...groups.values()].sort((a,b)=>b.count-a.count);
  $('#issue-groups').innerHTML = issues.length ? issues.slice(0,6).map(issue=>`<button class="issue-row" data-issue-service="${esc(issue.service)}"><span><strong>${esc(issue.kind)}</strong><small>${esc(issue.service)} · retained log sample</small></span><span>${issue.count} ${issue.count===1?'entry':'entries'} ›</span></button>`).join('') : '<p class="result-note">No issues in the retained log sample. This sample does not prove the entire run was error-free.</p>';
  const timeouts = issues.some(issue=>issue.kind==='Request timed out');
  $('#result-next-step').textContent = !hasRun ? 'Start with a small test to learn the baseline.' : timeouts ? 'Some calls exceeded their deadline. Inspect slow/failed requests, check service code and resource usage, and compare a smaller run. The log identifies the timeout symptom; it does not prove the bottleneck.' : failed > 0 ? 'Inspect failing requests and the test script. Check configured delays/failures and service readiness before changing capacity.' : 'Try a longer run or compare another load while watching latency, failures and resource usage.';
  $('#prepare-smaller-run').disabled = !hasRun || active;
  if (terminalPaused) return;
  const serviceSelect = $('#terminal-service'), currentService = serviceSelect.value;
  const services = [...new Set(state.logs.map(line=>line.service))].sort();
  const serviceSignature = services.join('|');
  if (serviceSelect.dataset.signature !== serviceSignature) { serviceSelect.innerHTML = '<option value="">All services</option>'+services.map(service=>`<option value="${esc(service)}">${esc(service)}</option>`).join(''); serviceSelect.value = currentService; serviceSelect.dataset.signature = serviceSignature; }
  const search = $('#terminal-search').value.trim().toLowerCase(), service = serviceSelect.value, issuesOnly = $('#terminal-level').value === 'issues';
  const lines = state.logs.filter(line=>(!service || line.service===service) && (!issuesOnly || issueKind(line)) && (!search || `${line.time} ${line.service} ${line.message}`.toLowerCase().includes(search)));
  const signature = JSON.stringify(lines);
  if (signature !== terminalSignature) {
    const scroll = $('#event-log').scrollTop;
    $('#event-log').innerHTML = lines.length ? lines.map(line=>`<div class="log-line ${issueKind(line)?'log-issue':''}"><time>${esc(line.time)}</time><b>${esc(line.service)}</b><span>${esc(line.message)}</span></div>`).join('') : '<div class="empty">No matching output. Change the filters or start a test.</div>';
    $('#event-log').scrollTop = $('#terminal-follow').checked ? $('#event-log').scrollHeight : scroll;
    terminalSignature = signature; terminalVisible = lines;
  }
  $('#terminal-count').textContent = `${lines.length} of ${state.logs.length} retained entries`;
}
function setupCompactLayout() {
  const infra = $('#infra-view'), panels = [
    ['project','Project', ['.project-panel']],
    ['resources','Resources',['.budget-strip','.infra-grid']],
    ['measurements','Measurements',['.workload-panel']],
    ['usage','Usage',['.database-panel']],
  ];
  const nav = document.createElement('div'); nav.className = 'section-tabs'; nav.setAttribute('role','tablist'); nav.setAttribute('aria-label','Project workspace');
  const stage = document.createElement('div'); stage.className = 'infra-stage';
  for (const [id,title,selectors] of panels) {
    const button = document.createElement('button'); button.id = `infra-tab-${id}`; button.textContent = title; button.dataset.infraTab = id; button.setAttribute('role','tab'); button.setAttribute('aria-controls',`infra-panel-${id}`); nav.append(button);
    const panel = document.createElement('section'); panel.id = `infra-panel-${id}`; panel.className = 'infra-section'; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',button.id);
    for (const selector of selectors) panel.append($(selector)); stage.append(panel);
  }
  infra.prepend(nav,stage);
  function choose(id, focus=false) {
    nav.querySelectorAll('button').forEach(button=>{ const selected = button.dataset.infraTab===id; button.setAttribute('aria-selected',String(selected)); button.tabIndex = selected ? 0 : -1; });
    stage.querySelectorAll('.infra-section').forEach(panel=>panel.classList.toggle('hidden',panel.id!==`infra-panel-${id}`));
    if (focus) $(`#infra-tab-${id}`).focus();
  }
  nav.onclick = event=>{const button=event.target.closest('[data-infra-tab]');if(button)choose(button.dataset.infraTab);};
  nav.onkeydown = event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return; event.preventDefault(); const buttons=[...nav.querySelectorAll('button')], current=buttons.indexOf(document.activeElement); const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length; choose(buttons[next].dataset.infraTab,true);};
  choose('project');
}
const serviceInfo = {
  nginx: ['Nginx', 'Reverse proxy', 'Routes the local gateway to web and API services.'],
  web: ['Web application', 'Next.js / custom app', 'Runs your project from its Dockerfile. Environment changes require a rebuild.'],
  api: ['API server', 'Application service', 'Application service configured by the project.'],
  worker: ['Background worker', 'Background process', 'A separate background process. Its runtime command must be defined by the project.'],
  postgres: ['PostgreSQL', 'Relational database', 'An isolated lab database with its own persistent volume. No production data is imported.'],
  redis: ['Redis', 'Cache / queues / streams', 'Optional cache, queue or event store. A declared client dependency is a candidate; review whether this project uses it.'],
  kafka: ['Kafka', 'Optional event broker', 'Single-node KRaft sandbox. Application integration must be configured explicitly.'],
  rabbitmq: ['RabbitMQ', 'Message broker', 'AMQP messaging and management UI at localhost:15673. Optional; connect your application explicitly.'],
  mongodb: ['MongoDB', 'Document database', 'An isolated document store at mongodb:27017 inside the lab network.'],
  mysql: ['MySQL', 'Relational database', 'An isolated MySQL database at mysql:3306 inside the lab network.'],
  minio: ['MinIO', 'S3-compatible storage', 'Object storage API at localhost:19000 and console at localhost:19001. Create buckets and connect your app explicitly.'],
  prometheus: ['Prometheus', 'Metrics collection', 'Metrics server at localhost:19090. Self-scraping is provided. App metrics require exporters or an instrumented endpoint.'],
  grafana: ['Grafana', 'Observability dashboards', 'Dashboard UI at localhost:13000. A Prometheus data source is provisioned when Prometheus is enabled. Application dashboards and exporters are not preinstalled.'],
};
const descriptions = {
  infra: ['Infrastructure', 'A private test environment for FreshPhones. Everything runs locally.'],
  workspace: ['Code sandbox', 'Edit JavaScript services and experiment with latency, failures, and partitions.'],
  scenario: ['Virtual users', 'Script the actions your users take, with independent state and time to think.'],
  traffic: ['Request traces', 'Inspect calls through the demo network. Project traffic is measured by k6 and Docker.'],
  logs: ['Results & terminal', 'Understand the run, inspect issues, and read technical output.'],
  research: ['Design notes', 'A minimal workspace informed by human studies and Apple interface guidance.'],
};
function notice(message, error = false) { $('#notice').classList.remove('hidden'); $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function markDirty() { dirty = true; $('#save').textContent = 'Save changes'; }
async function api(endpoint, data) {
  const response = await fetch(endpoint, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}
function rememberEditors() {
  const service = project?.services.find(s => s.id === selected);
  if (service) service.code = $('#code').value;
  if (project) project[$('#run-target').value === 'project' ? 'freshScenario' : 'scenario'] = $('#scenario-code').value;
}
async function saveProject() {
  rememberEditors(); rememberPlan();
  await api('/api/save', project);
  await saveWorkload();
  if(config.mode==='detected'&&config.definition){for(const [id,s] of Object.entries(config.definition.services))s.enabled=Boolean(config.resources[id]?.enabled);await api('/api/project/manifest',{projectPath:config.projectPath,definition:config.definition});}
  dirty = false; $('#save').textContent = 'Save workspace';
}
async function action(task, success) {
  if (acting) return;
  acting = true; document.body.classList.add('working');
  renderButtons();
  try { await task(); if (success) notice(success); await refresh(); }
  catch (error) { notice(error.message, true); }
  finally { acting = false; document.body.classList.remove('working'); renderButtons(); }
}
function changeView(next) {
  if (!$('#notice').classList.contains('error')) $('#notice').classList.add('hidden');
  view = next; document.body.dataset.view = next; document.documentElement.scrollTop = 0; if ($('main')) $('main').scrollTop = 0;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('hidden', el.id !== `${next}-view`));
  document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === next); el.setAttribute('aria-current', el.dataset.view === next ? 'page' : 'false'); });
  $('#page-title').textContent = descriptions[next][0]; $('#page-description').textContent = descriptions[next][1];
  $('#start').classList.toggle('hidden', next !== 'workspace'); $('#stop-services').classList.toggle('hidden', next !== 'workspace');
  if (next === 'workspace') { $('#run-target').value = 'demo'; updateScenario(); }
  if (next === 'infra') { $('#run-target').value = 'project'; updateScenario(); }
  history.replaceState(null, '', `#${next}`);
}
function lineNumbers() { $('#line-numbers').textContent = $('#code').value.split('\n').map((_, i) => i + 1).join('\n'); }
function selectService(id) {
  rememberEditors(); selected = id;
  $('#code').value = project.services.find(s => s.id === id)?.code || '';
  lineNumbers(); renderSandbox();
}
function renderSandbox() {
  if (!project) return;
  const nodes = [{ id: 'users' }, ...project.services];
  $('#topology').innerHTML = nodes.map((node, index) => {
    const live = node.id === 'users' ? state.run.status === 'running' && state.run.target === 'demo' : state.services[node.id]?.running;
    const nodeHTML = `<button class="node ${live ? 'running' : ''} ${selected === node.id ? 'selected' : ''} ${node.id === 'users' ? 'users-node' : ''}" data-node="${esc(node.id)}"><span class="status-dot"></span><span class="node-icon">${node.id === 'users' ? '♧' : '{ }'}</span><span class="node-name">${node.id === 'users' ? 'Virtual users' : esc(node.id)}</span><span class="node-meta">${node.id === 'users' ? 'k6 · independent sessions' : live ? `Running · :${state.services[node.id].port}` : 'Stopped · Node.js'}</span></button>`;
    if (!index) return nodeHTML;
    const link = project.links.find(l => l.source === nodes[index - 1].id && l.target === node.id);
    return `<div class="wire ${!link?.enabled ? 'broken' : ''}"><small>${link ? `${link.latency} ms` : 'No link'}</small><div class="wire-line"></div></div>${nodeHTML}`;
  }).join('');
  $('#service-tabs').innerHTML = project.services.map(s => `<button class="tab ${selected === s.id ? 'active' : ''}" data-tab="${esc(s.id)}" aria-pressed="${selected === s.id}">${esc(s.id)}.mjs</button>`).join('');
}
function renderLinks() {
  $('#links').innerHTML = project.links.map((link, i) => `<div class="link-row"><div class="link-top">${esc(link.source)}<span class="arrow">→</span>${esc(link.target)}<button class="link-toggle ${!link.enabled ? 'disconnected' : ''}" data-toggle-link="${i}">${link.enabled ? 'Connected' : 'Disconnected'}</button><button class="link-remove" data-remove-link="${i}" aria-label="Remove ${esc(link.source)} to ${esc(link.target)} link">×</button></div><div class="link-inputs"><label>Delay<input aria-label="${esc(link.source)} to ${esc(link.target)} latency in milliseconds" type="number" min="0" max="2000" value="${link.latency}" data-link="${i}" data-key="latency">ms</label><label>Failure<input aria-label="${esc(link.source)} to ${esc(link.target)} failure percentage" type="number" min="0" max="100" value="${link.failure}" data-link="${i}" data-key="failure">%</label></div></div>`).join('');
  $('#link-source').innerHTML = ['users', ...project.services.map(s => s.id)].map(id => `<option>${esc(id)}</option>`).join('');
  $('#link-target').innerHTML = project.services.map(s => `<option>${esc(s.id)}</option>`).join('');
}
function updateScenario() { syncChoices(); oldTarget = $('#run-target').value; $('#scenario-code').value = project[oldTarget === 'project' ? 'freshScenario' : 'scenario']; }
function renderButtons() {
  if (!state) return;
  for (const selector of ['#baseline-run', '#save-workload', '#save', '#start', '#stop-services', '#run', '#stop-run', '#prepare-infra', '#start-infra', '#stop-infra', '#rescan-project', '#save-project-file']) $(selector).disabled = acting;
  $('#save-workload').disabled ||= !workloadsLoaded;
  const runActive = ['running', 'stopping'].includes(state.run.status);
  $('#stop-run').disabled = acting || !runActive;
  $('#run').disabled = acting || runActive;
  for (const id of ['#prepare-infra', '#start-infra', '#stop-infra']) $(id).disabled = acting || state.infra.busy;
  const selectedStack = config?.projectPath === state.infra.config.projectPath;
  $('#stop-infra').disabled ||= !selectedStack;
  document.querySelectorAll('[data-service-action]').forEach(button => { button.disabled = acting || state.infra.busy || !selectedStack; });
  document.querySelectorAll('[data-remove-resource]').forEach(button=>{button.disabled=acting||Boolean(requiredResourceReason(button.dataset.removeResource));});
  $('#remove-inspector-resource').disabled=acting||!config.resources[inspected]?.enabled;
  syncChoices();
  $('#start').textContent = Object.values(state.services).some(s => s.running) ? '↻ Restart demo' : '▶ Start demo';
}
function renderLive() {
  const m = state.metrics;
  const observationKey = `${config.projectPath}:${automaticWorkload()?.id || ''}:${state?.observations?.__demo__?.id || ''}`;
  if (workloadsLoaded && renderedObservation !== observationKey && !document.activeElement?.matches('[data-workload]')) { readWorkload(); renderWorkload(); }
  $('#run-toolbar-status').textContent = state.run.status === 'idle' ? 'Choose the target and user count.' : ['running','stopping'].includes(state.run.status) ? `${m.vus} active users · ${m.rps.toFixed(1)} requests/s` : `Last ${state.run.target === 'project' ? 'project' : 'demo'} test: ${state.run.status} · ${m.failureRate.toFixed(1)}% failed`;
  $('#metric-vus').textContent = m.vus;
  $('#run-state').textContent = state.run.status === 'idle' ? 'No run yet' : `${state.run.target === 'project' ? 'Project' : 'Demo'} · ${state.run.status}`;
  $('#metric-rps').innerHTML = `${m.rps.toFixed(1)} <em>req/s</em>`;
  $('#metric-p95').innerHTML = `${m.samples ? m.p95.toFixed(0) : '—'} <em>ms</em>`;
  $('#metric-errors').innerHTML = `${m.failureRate.toFixed(1)}<em>%</em>`;
  $('#request-count').textContent = `${m.requests.toLocaleString()} requests · ${m.passed}/${m.checks} checks passed`;
  $('#traces').innerHTML = state.traces.length ? state.traces.map(t => `<tr><td>${esc(t.time)}</td><td>${esc(t.source)} → ${esc(t.target)}</td><td>${esc(t.path)}</td><td class="${t.status < 400 ? 'good' : 'bad'}">${t.status}</td><td class="numeric">${t.ms} ms</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Run the code sandbox to see requests through each network link.</td></tr>';
  renderResults();
  renderSandbox(); renderInfraLive(); renderButtons();
}
function visibleResources() { return Object.entries(config.resources).filter(([id]) => config.mode==='detected'?(!['web','api','worker'].includes(id)||config.definition?.services[id]):config.mode !== 'custom' || !['api', 'worker'].includes(id)); }
const planSizes={small:[1,1024],standard:[2,4096],large:[4,8192],heavy:[8,16384]};
const planWeights={nginx:[.25,128],web:[1,1024],api:[1,1024],worker:[.5,512],postgres:[1,1024],redis:[.5,256],kafka:[1,1536],rabbitmq:[.5,512],mongodb:[1,1024],mysql:[1,1024],minio:[.5,512],prometheus:[.5,512],grafana:[.5,512]};
function ensurePlan() {
  if(!config.plan){const resources=visibleResources().filter(([,r])=>r.enabled);config.plan={preset:'current',cpu:Math.round(resources.reduce((n,[,r])=>n+r.cpu,0)*100)/100,ram:resources.reduce((n,[,r])=>n+r.ram,0),allocation:'automatic',billing:{model:'estimate',price:0,credit:0}};}
  config.plan.billing??={model:'estimate',price:0,credit:0};
}
function distributePlan() {
  ensurePlan();if(config.plan.allocation!=='automatic')return;
  const ids=visibleResources().filter(([,r])=>r.enabled).map(([id])=>id), plan=config.plan;
  if(!ids.length)return;
  if(!Number.isFinite(plan.cpu)||plan.cpu<.1||plan.cpu>16||!Number.isInteger(plan.ram)||plan.ram<64||plan.ram>16384||plan.ram%64)throw new Error('Use 0.1–16 total CPU and RAM in 64 MiB steps, up to 16 GiB.');
  function split(total,minimum,weightIndex){
    if(total<ids.length*minimum)throw new Error(`This service count needs at least ${(ids.length*.1).toFixed(1)} CPU and ${ids.length*64} MiB RAM. Choose a larger overall plan.`);
    const remaining=total-ids.length*minimum, weights=ids.map(id=>(planWeights[id] || [1,512])[weightIndex]),sum=weights.reduce((a,b)=>a+b,0);
    const exact=weights.map(w=>remaining*w/sum),shares=exact.map(n=>Math.floor(n)+minimum);
    let extra=total-shares.reduce((a,b)=>a+b,0);
    const order=exact.map((n,i)=>({i,f:n-Math.floor(n)})).sort((a,b)=>b.f-a.f);
    for(let i=0;i<extra;i++)shares[order[i%order.length].i]++;
    return shares;
  }
  const cpu=split(Math.floor(plan.cpu*100+1e-7),10,0),ram=split(plan.ram/64,1,1);
  ids.forEach((id,index)=>{config.resources[id].cpu=cpu[index]/100;config.resources[id].ram=ram[index]*64;});
  config.databaseBuffers=Math.min(config.databaseBuffers,Math.max(16,Math.floor(config.resources.postgres.ram/2)));
  config.redisMemory=Math.min(config.redisMemory,Math.max(16,Math.floor(config.resources.redis.ram*.5)));
}
function planProblem(){
  const resources=visibleResources().filter(([,r])=>r.enabled).map(([,r])=>r),cpu=resources.reduce((n,r)=>n+r.cpu,0),ram=resources.reduce((n,r)=>n+r.ram,0);
  return cpu>config.plan.cpu+.00001||ram>config.plan.ram?'Allocations exceed the overall plan. Auto-distribute, remove a service, or increase total capacity.':'';
}
function renderPlanInputs(){
  ensurePlan();$('#environment-plan').value=config.plan.preset||'custom';$('#plan-cpu').value=config.plan.cpu;$('#plan-ram').value=config.plan.ram/1024;$('#plan-storage').value=config.storageGB;syncChoices();
}
function rememberPlan(){if(!project||!config.plan)return;project.environmentPlans??={};project.environmentPlans[config.projectPath]={...structuredClone(config.plan),storageGB:config.storageGB};}
function changePlan(preset){
  ensurePlan();const before=structuredClone(config);
  try{
    config.plan.preset=preset;config.plan.allocation='automatic';
    if(planSizes[preset]){[config.plan.cpu,config.plan.ram]=planSizes[preset];}
    else{config.plan.cpu=Number($('#plan-cpu').value);config.plan.ram=Math.round(Number($('#plan-ram').value)*1024);}
    config.storageGB=Number($('#plan-storage').value);
    if(!Number.isInteger(config.storageGB)||config.storageGB<1||config.storageGB>10000)throw new Error('Storage budget must be 1–10000 GB.');
    distributePlan();rememberPlan();renderPlanInputs();renderResources();markDirty();notice('Overall plan updated. Prepare and start the stack to apply the new container shares.');
  }catch(error){config=before;renderPlanInputs();notice(error.message,true);}
}
function estimate() {
  ensurePlan();const resources=visibleResources().filter(([,r])=>r.enabled).map(([,r])=>r),cpu=resources.reduce((n,r)=>n+r.cpu,0),ram=resources.reduce((n,r)=>n+r.ram,0),p=config.plan,b=p.billing;
  const usage=(p.cpu*config.rates.cpuHour+p.ram/1024*config.rates.ramGBHour)*config.rates.hours+config.storageGB*config.rates.storageGBMonth;
  const overage=b.model==='metered'?Math.max(0,usage-b.credit):0,monthly=b.model==='fixed'?b.price:b.model==='metered'?b.price+overage:usage;
  $('#budget-total').textContent=`Allocated ${cpu.toFixed(2)} / ${p.cpu} CPU · ${(ram/1024).toFixed(2)} / ${(p.ram/1024).toFixed(2)} GiB RAM`;
  $('#cost-total').textContent=`$${monthly.toFixed(2)} / month`;
  $('#plan-price-label').textContent=b.model==='fixed'?'Your entered VPS price':b.model==='metered'?'Projected base + overage':'Illustrative monthly projection';
  $('#plan-overage').textContent=b.model==='metered'?`$${b.price.toFixed(2)} base + $${overage.toFixed(2)} projected overage · $${b.credit.toFixed(2)} credit · ${config.rates.hours}h capacity projection`:b.model==='fixed'?'Specifications and price entered by you':'Edit rates to match an offer';
  const problem=planProblem();$('#plan-feedback').textContent=problem||`${p.allocation==='automatic'?'Automatically distributed':'Custom service shares'} · Storage is a planning budget, not an enforced disk quota.`;$('#plan-feedback').classList.toggle('bad',Boolean(problem));
}
function requiredResourceReason() { return ''; }
function removeResource(id) {
  const reason=requiredResourceReason(id);
  if(reason)return notice(`${serviceInfo[id][0]} cannot be removed: ${reason} Use Stop to simulate an outage.`,true);
  if(!config.resources[id]?.enabled)return;
  readInspector(); config.resources[id].enabled=false;
  if(config.definition?.services[id])config.definition.services[id].enabled=false;
  if(inspected===id)inspected=visibleResources().find(([,r])=>r.enabled)?.[0] || 'web';
  const warning=dependencyWarning(id);
  renderResources();renderInfraLive();renderButtons();markDirty();
  const automatic=config.plan.allocation==='automatic';
  notice(`${serviceInfo[id][0]} removed from the plan. ${automatic?'Remaining service shares were rebalanced.':'Capacity is available; use Auto-distribute to rebalance.'} Prepare and start the stack to apply. Data volumes are kept. ${warning}`);
  const undo=document.createElement('button');undo.className='small undo-resource';undo.textContent='Undo';undo.setAttribute('aria-label',`Restore ${serviceInfo[id][0]}`);
  undo.onclick=()=>{readInspector();config.resources[id].enabled=true;if(config.definition?.services[id])config.definition.services[id].enabled=true;inspected=id;renderResources();renderInfraLive();renderButtons();markDirty();notice(`${serviceInfo[id][0]} restored to the plan.`);document.querySelector(`[data-inspect="${id}"]`)?.focus();};
  $('#notice').append(undo);
  document.querySelector(`[data-inspect="${inspected}"]`)?.focus();
}
function renderResources() {
  if(!config.resources[inspected])inspected=Object.keys(config.resources)[0];
  ensurePlan();try{distributePlan();}catch(error){notice(error.message,true);}
  renderPlanInputs();
  $('#resource-list').innerHTML = visibleResources().filter(([, r]) => r.enabled).map(([id,r]) => {
    const reason=requiredResourceReason(id), title=reason?`${serviceInfo[id][0]} is required. ${reason}`:`Remove ${serviceInfo[id][0]} from the plan`;
    return `<div class="resource-item"><button class="resource-row ${inspected===id?'selected':''}" data-inspect="${id}"><span class="resource-symbol">${resourceSymbol(id)}</span><span class="resource-name"><strong>${serviceInfo[id][0]}</strong><small>${serviceInfo[id][1]}</small></span><span class="resource-budget">${r.cpu} vCPU<br>${r.ram} MiB</span><span class="service-state" id="service-status-${id}">Planned</span><span class="chevron">›</span></button><button class="resource-remove" data-remove-resource="${id}" aria-label="${esc(title)}" title="${esc(title)}" ${reason?'disabled':''}>×</button></div>`;
  }).join('')+'<button class="catalog-inline-add" id="inline-add-resource">+ Add another resource</button>';
  renderInspector(); estimate(); rememberPlan();
}
function renderInspector() {
  const r = config.resources[inspected], info = serviceInfo[inspected], required = requiredResourceReason(inspected);
  $('#inspector-title').textContent = info[0];
  const removeButton=$('#remove-inspector-resource');removeButton.disabled=!r.enabled;removeButton.title=required||`Remove ${info[0]} from the plan`;removeButton.setAttribute('aria-label',required?`${info[0]} is required. ${required}`:`Remove ${info[0]} from the plan`);
  $('#inspector').innerHTML = `<p class="inspector-description">${config.mode==='custom'&&inspected==='redis'?'Optional cache, queue or event store for this project. The app must be configured to use it.':info[2]}</p><div class="service-plan-share"><strong>${r.cpu} vCPU · ${r.ram} MiB RAM</strong><span>Allocated from the overall ${config.plan.cpu} CPU / ${(config.plan.ram/1024).toFixed(2)} GiB plan</span></div><div class="resource-removal"><p>${required?`${required} Use Stop below to simulate an outage.`:'Removes this service from the plan. Prepare and start to apply; stored data is retained.'}</p></div><details class="allocation-advanced"><summary>Advanced: customize this service’s share</summary><div class="settings-group"><label class="setting-row"><span>Include service</span><input type="checkbox" role="switch" id="resource-enabled" ${required?'disabled':''} ${r.enabled ? 'checked' : ''}></label><label class="setting-row"><span>CPU limit <small>Fractional cores allowed</small></span><span><input id="resource-cpu" type="number" min="0.1" max="16" step="0.1" value="${r.cpu}" aria-label="${info[0]} CPU cores"> vCPU</span></label><label class="setting-row"><span>Memory limit <small>Swap disabled for this container</small></span><span><input id="resource-ram" type="number" min="64" max="16384" step="64" value="${r.ram}" aria-label="${info[0]} RAM in MiB"> MiB</span></label></div>${inspected === 'postgres' ? `<div class="settings-group"><label class="setting-row">Max connections<input id="database-connections" type="number" min="20" max="1000" value="${config.databaseConnections}"></label><label class="setting-row">Shared buffers (MiB)<input id="database-buffers" type="number" min="16" max="4096" value="${config.databaseBuffers}"></label></div>` : ''}${inspected === 'redis' ? `<div class="settings-group"><label class="setting-row">Data memory (MiB)<input id="redis-memory" type="number" min="16" max="8192" value="${config.redisMemory}"></label></div>` : ''}<p class="inspector-note">Prepare and start the stack to apply limits. Changes do not modify an existing running container until you start again.</p></details><div class="service-controls"><span>Running container</span><div><button class="small" data-service-action="restart">Restart</button><button class="small" data-service-action="pause">Pause</button><button class="small" data-service-action="unpause">Resume</button><button class="small" data-service-action="stop">Stop</button><button class="small" data-service-action="start">Start</button></div></div><p class="inspector-note">Pause simulates a stalled service. Stop creates an outage. Persistent volumes are retained.</p>`;
  const definition=config.definition?.services[inspected];
  if(definition){const evidence=document.createElement('div');evidence.className='detection-evidence';evidence.innerHTML=`<strong>Why this service is here</strong><p>${definition.origin==='lab-adapter'?'Explicit lab gateway configuration.':definition.origin==='manual'?'Added by you.':'Project definition / code evidence'}</p>${(definition.evidence||[]).map(e=>`<p><code>${esc(e.file)}${e.line?':'+e.line:''}</code> · ${esc(e.reason)}</p>`).join('')}<p>${esc(dependencyWarning(inspected))}</p>`;$('#inspector').prepend(evidence);}
  $('#inspector').scrollTop=0;
}
function readInspector(event) {
  const r = config.resources[inspected];
  if(!r || !$('#resource-enabled'))return;
  if(event?.target?.id==='resource-enabled'&&!event.target.checked){event.target.checked=true;removeResource(inspected);return;}
  if(event&&['resource-cpu','resource-ram'].includes(event.target?.id)&&config.plan)config.plan.allocation='manual';
  r.enabled = $('#resource-enabled').checked; r.cpu = Number($('#resource-cpu').value); r.ram = Number($('#resource-ram').value);
  if ($('#database-connections')) config.databaseConnections = Number($('#database-connections').value);
  if ($('#database-buffers')) config.databaseBuffers = Number($('#database-buffers').value);
  if ($('#redis-memory')) config.redisMemory = Number($('#redis-memory').value);
  if(event?.target?.id==='resource-enabled'){try{distributePlan();}catch(error){notice(error.message,true);}renderResources();$('#resource-enabled').focus();markDirty();return;}
  estimate();rememberPlan();
  const row = $(`[data-inspect="${inspected}"] .resource-budget`);
  if (row) row.innerHTML = `${r.cpu} vCPU<br>${r.ram} MiB`;
}
function readConfig() {
  readInspector();
  config.mode = $('#project-mode').value; config.projectPath = $('#project-path').value.trim();
  syncProjectLabels();
  config.entryPort = Number($('#entry-port').value); config.dockerfile = $('#dockerfile').value; config.appPort = Number($('#app-port').value);
  ensurePlan();if(config.plan.allocation==='automatic')distributePlan();const problem=planProblem();if(problem)throw new Error(problem);rememberPlan();
  return structuredClone(config);
}
function renderInfraLive() {
  const infra = state.infra;
  $('#docker-badge').textContent = infra.docker.message;
  $('#docker-badge').classList.toggle('bad', !infra.docker.available);
  $('#host-capacity').textContent = `${infra.host.cpu} threads · ${(infra.host.totalRAM / 1024 ** 3).toFixed(1)} GiB RAM`;
  const selectedStack = config.projectPath === infra.config.projectPath;
  const starting = selectedStack && infra.busy && infra.status === 'Starting stack';
  const progress = starting ? state.logs.filter(line => line.service === 'docker').at(-1)?.message : '';
  const gatewayRunning = selectedStack && infra.containers.some(container => (container.Service === 'nginx' || container.Service === config.definition?.entry) && container.State === 'running');
  $('#infra-status').textContent = !selectedStack ? 'Selected project not prepared' : starting ? 'Starting stack · site not ready yet' : infra.status === 'idle' ? 'Stack not started' : infra.status;
  $('#infra-message').textContent = !selectedStack ? `${projectName()} is selected. Prepare its stack to save these settings. ${infra.busy ? 'Another project is still starting; wait for that operation to finish.' : 'Each project uses separate containers, configuration, and data volumes.'}` : infra.error || (starting
    ? `Downloading images, building the application, and starting services. The first start can take several minutes; watch progress here or in Event log. ${progress || 'Waiting for Docker output…'}`
    : !infra.docker.available
      ? `${infra.docker.message}. The lab checks for both system Docker and your account’s rootless runtime automatically. You can still prepare the stack and use the code sandbox.`
      : gatewayRunning
        ? `Gateway running at http://localhost:${infra.config.entryPort}. If the app is still initializing, check Event log for startup errors. CPU/RAM caps ${infra.docker.cpuLimit && infra.docker.memoryLimit ? 'supported' : 'unavailable on this runtime'}.`
        : `Connected: ${infra.docker.message}. The project site is not running yet. Start stack to download, build, and start it; Start demo runs only the code sandbox.`);
  $('#docker-details').classList.toggle('hidden', !infra.docker.detail);
  $('#docker-error-detail').textContent = infra.docker.detail || '';
  for (const [id, r] of visibleResources()) {
    const element = $(`#service-status-${id}`); if (!element) continue;
    const c = selectedStack ? infra.containers.find(c => c.Service === id) : null;
    element.textContent = c ? c.State : r.enabled ? 'Planned' : 'Off';
    element.classList.toggle('good', c?.State === 'running');
  }
  $('#container-stats').innerHTML = infra.stats.length ? infra.stats.map(s => `<tr><td>${esc(s.Name)}</td><td>${esc(s.CPUPerc)}</td><td>${esc(s.MemUsage)}</td><td>${esc(s.NetIO)}</td><td>${esc(s.BlockIO)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Start the stack to see measured usage. No metrics are simulated.</td></tr>';
  $('#db-stats').textContent = infra.db ? `PostgreSQL · ${infra.db.connections} connections · ${(infra.db.databaseBytes / 1024 ** 2).toFixed(1)} MiB data` : 'No database measurements yet';
}
async function refresh() {
  const next = await api('/api/state'); state = next;
  if (!project) {
    project = next.project; config = structuredClone(next.infra.config);
    $('#code').value = project.services.find(s => s.id === selected)?.code || '';
    $('#project-mode').value = config.mode; $('#project-path').value = config.projectPath; $('#entry-port').value = config.entryPort;
    $('#dockerfile').value = config.dockerfile; $('#app-port').value = config.appPort;
    try{await detectProject();}catch(error){notice(`Detection failed: ${error.message}. Choose a project and retry.`,true);}
    syncProjectLabels(); updateScenario(); lineNumbers(); renderLinks(); renderResources();
    const initial = location.hash.slice(1); changeView(descriptions[initial] ? initial : 'infra');
  }
  renderLive();
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { rememberEditors(); changeView(button.dataset.view); }));
$('#code').addEventListener('input', () => { markDirty(); lineNumbers(); });
$('#code').addEventListener('scroll', () => { $('#line-numbers').scrollTop = $('#code').scrollTop; });
$('#scenario-code').addEventListener('input', markDirty);
for (const selector of ['#code', '#scenario-code']) $(selector).addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); const input = event.target; input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end'); markDirty(); lineNumbers(); }
});
$('#save').onclick = () => action(async () => { await saveProject(); await api('/api/infra/prepare', readConfig()); }, 'Workspace and resource settings saved. Restart services or rerun the journey to apply code.');
$('#start').onclick = () => action(async () => { await saveProject(); await api('/api/start', {}); }, 'Demo services are running.');
$('#stop-services').onclick = () => action(() => api('/api/stop', {}), 'Demo stopped.');
$('#run').onclick = () => action(async () => {
  if (!$('#users').checkValidity() || !$('#ramp').checkValidity() || !$('#duration').checkValidity()) throw new Error('Check user count, ramp, and duration.');
  if ($('#run-target').value === 'project' && (config.projectPath !== state.infra.config.projectPath)) throw new Error('Prepare and start the selected project before running its journey.');
  const users = Number($('#users').value);
  if (!Number.isSafeInteger(users) || users < 1) throw new Error('Users must be a positive whole number that can be represented exactly.');
  await saveProject(); await api('/api/load', { users, ramp: Number($('#ramp').value), duration: Number($('#duration').value), target: $('#run-target').value });
}, 'k6 journey started. Metrics update live.');
$('#stop-run').onclick = () => action(() => api('/api/load/stop', {}), 'User journey stopped.');
$('#run-target').onchange = () => { project[oldTarget === 'project' ? 'freshScenario' : 'scenario'] = $('#scenario-code').value; oldTarget = $('#run-target').value; updateScenario(); };
$('#topology').onclick = event => { const node = event.target.closest('[data-node]'); if (node?.dataset.node === 'users') changeView('scenario'); else if (node) selectService(node.dataset.node); };
$('#service-tabs').onclick = event => { const tab = event.target.closest('[data-tab]'); if (tab) selectService(tab.dataset.tab); };
$('#links').onchange = event => { const input = event.target.closest('[data-link]'); if (input) { project.links[Number(input.dataset.link)][input.dataset.key] = Number(input.value); markDirty(); action(saveProject, 'Network settings applied.'); } };
$('#links').onclick = event => {
  const toggle = event.target.closest('[data-toggle-link]'), remove = event.target.closest('[data-remove-link]');
  if (toggle) { const l = project.links[Number(toggle.dataset.toggleLink)]; l.enabled = !l.enabled; }
  else if (remove) project.links.splice(Number(remove.dataset.removeLink), 1);
  else return;
  renderLinks(); action(saveProject, 'Network connection updated.');
};
$('#connect').onclick = () => {
  const source = $('#link-source').value, target = $('#link-target').value;
  if (project.links.some(l => l.source === source && l.target === target)) return notice('That connection already exists.', true);
  project.links.push({ source, target, latency: 0, failure: 0, enabled: true }); renderLinks(); action(saveProject, 'Network connection added.');
};
let catalogMode = 'infra';
function resourceSymbol(id) { return ({ nginx: '⇄', web: '▣', api: '{ }', worker: '⚙', postgres: '▤', redis: '▱', kafka: '⋈', rabbitmq: '⇶', mongodb: '▥', mysql: '▤', minio: '◫', prometheus: '⌁', grafana: '◉' })[id] || '{ }'; }
const codeTemplates = {
  'http-api': { title: 'HTTP API', description: 'An editable Node.js request handler.', code: `export default async function(req, ctx) {\n  return { service: ctx.name, path: req.path, ok: true };\n}\n` },
  'gateway': { title: 'API gateway', description: 'Forward requests to another code service.', code: `export default async function(req, ctx) {\n  return ctx.call('api', req.path, { method: req.method, body: req.body });\n}\n` },
  'slow-service': { title: 'Latency test service', description: 'A real service with a configurable processing delay.', code: `export default async function(req, ctx) {\n  await ctx.sleep(250);\n  return { service: ctx.name, processingMs: 250 };\n}\n` },
};
function renderCatalog() {
  const filter = $('#catalog-search').value.trim().toLowerCase();
  $('#catalog-infra-tab').setAttribute('aria-selected', catalogMode === 'infra');
  $('#catalog-code-tab').setAttribute('aria-selected', catalogMode === 'code');
  $('#catalog-infra-tab').tabIndex = catalogMode === 'infra' ? 0 : -1;
  $('#catalog-code-tab').tabIndex = catalogMode === 'code' ? 0 : -1;
  $('#resource-catalog').setAttribute('aria-labelledby', catalogMode === 'infra' ? 'catalog-infra-tab' : 'catalog-code-tab');
  $('#catalog-explanation').textContent = catalogMode === 'infra' ? 'Real container services, with configurable CPU and memory caps. Docker is required to run them.' : 'Editable Node.js services for the code sandbox. These run as local processes without container resource caps.';
  $('#resource-catalog').innerHTML = catalogMode === 'infra' ? visibleResources().map(([id, r]) => `<button class="catalog-card" data-catalog-resource="${id}"><span class="resource-symbol">${resourceSymbol(id)}</span><span class="catalog-card-copy"><strong>${serviceInfo[id][0]}</strong><span>${serviceInfo[id][1]}</span><small>${r.cpu} vCPU · ${r.ram} MiB RAM${id === 'kafka' ? ' · optional integration' : ''}</small></span><span class="catalog-card-action">${r.enabled ? 'Configure ›' : '+ Add'}</span></button>`).join('') : Object.entries(codeTemplates).map(([id, item]) => `<button class="catalog-card" data-catalog-template="${id}"><span class="resource-symbol">{ }</span><span class="catalog-card-copy"><strong>${item.title}</strong><span>${item.description}</span><small>Node.js · editable JavaScript</small></span><span class="catalog-card-action">+ Add</span></button>`).join('');
  let matches = 0;
  document.querySelectorAll('.catalog-card').forEach(card => { card.hidden = !card.textContent.toLowerCase().includes(filter); if (!card.hidden) matches++; });
  if (!matches) $('#resource-catalog').insertAdjacentHTML('beforeend', '<p class="empty">No matching resources. Try a database, proxy, cache, or queue.</p>');
}
function openCatalog() { readInspector(); catalogMode = 'infra'; $('#catalog-search').value = ''; renderCatalog(); $('#service-dialog').showModal(); }
$('#add-service').onclick = openCatalog;
$('#open-resources').onclick = openCatalog;
$('#close-catalog').onclick = () => $('#service-dialog').close();
$('#service-dialog').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); $('#service-dialog').close(); } });
$('#catalog-infra-tab').onclick = () => { catalogMode = 'infra'; renderCatalog(); };
$('#catalog-code-tab').onclick = () => { catalogMode = 'code'; renderCatalog(); };
$('#catalog-search').oninput = renderCatalog;
$('.catalog-tabs').onkeydown = event => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); catalogMode = event.key === 'Home' ? 'infra' : event.key === 'End' ? 'code' : catalogMode === 'infra' ? 'code' : 'infra';
    renderCatalog(); $(catalogMode === 'infra' ? '#catalog-infra-tab' : '#catalog-code-tab').focus();
  }
};
$('#resource-catalog').onclick = event => {
  const resource = event.target.closest('[data-catalog-resource]'), template = event.target.closest('[data-catalog-template]');
  if (resource) {
    const id = resource.dataset.catalogResource;
    config.resources[id].enabled = true;
    if(config.mode==='detected'){config.definition.services[id]??={kind:id,origin:'manual',evidence:[]};config.definition.services[id].enabled=true;}
    inspected = id; rememberEditors(); changeView('infra'); renderResources();
    $('#service-dialog').close(); notice(`${serviceInfo[id][0]} selected. Set its limits, then prepare and start the stack to apply.`);
    return;
  }
  if (!template) return;
  if (project.services.length >= 12) return notice('This lab supports up to 12 demo services.', true);
  const kind = template.dataset.catalogTemplate;
  let id = kind, number = 2;
  while (project.services.some(s => s.id === id)) id = `${kind}-${number++}`;
  rememberEditors(); project.services.push({ id, code: codeTemplates[kind].code });
  selected = id; $('#code').value = project.services.at(-1).code;
  changeView('workspace'); lineNumbers(); renderSandbox(); renderLinks(); markDirty(); $('#service-dialog').close();
  notice(`${codeTemplates[kind].title} added. Connect it to the network, then save and restart the demo.`);
};
$('#resource-list').onclick = event => {
  const remove=event.target.closest('[data-remove-resource]');if(remove){removeResource(remove.dataset.removeResource);return;}
  if (event.target.closest('#inline-add-resource')) return openCatalog();
  const row = event.target.closest('[data-inspect]'); if (row) { readInspector(); inspected = row.dataset.inspect; renderResources(); }
};
$('#remove-inspector-resource').onclick=()=>removeResource(inspected);
$('#inspector').oninput = readInspector;
$('#environment-plan').onchange=()=>changePlan($('#environment-plan').value);
for(const id of ['#plan-cpu','#plan-ram','#plan-storage'])$(id).onchange=()=>changePlan('custom');
$('#rebalance-plan').onclick=()=>changePlan(config.plan?.preset||'custom');
$('#inspector').onclick = event => { const button = event.target.closest('[data-service-action]'); if (button) action(() => { if (config.projectPath !== state.infra.config.projectPath) throw new Error('Prepare the selected project before controlling its containers.'); return api('/api/infra/service', { service: inspected, action: button.dataset.serviceAction }); }, 'Container action started. Check Event log for completion.'); };
$('#project-mode').onchange = () => action(async()=>{readInspector(); config.mode=$('#project-mode').value;if(config.mode==='detected')await detectProject();else {for(const id of Object.keys(config.resources))if(!Object.hasOwn(planWeights,id))delete config.resources[id];if(!config.resources[inspected])inspected='web';}renderResources();syncProjectLabels();markDirty();});
$('#prepare-infra').onclick = () => action(async () => {const settings=readConfig();await saveProject();await api('/api/infra/prepare',settings);}, 'Stack prepared. Configuration saved with runtime CPU and RAM limits.');
$('#start-infra').onclick = () => action(async () => {const settings=readConfig();await saveProject();await api('/api/infra/start',settings);}, 'Stack startup requested. Follow build progress in Event log.');
$('#stop-infra').onclick = () => action(() => api('/api/infra/stop', {}), 'Stack stop requested. Database volumes are retained.');
function updateBillingFields(){const mode=$('#billing-model').value;$('#billing-price').disabled=mode==='estimate';$('#billing-credit').disabled=mode!=='metered';}
$('#billing-model').onchange=updateBillingFields;
$('#cost-settings').onclick = () => {
  ensurePlan();$('#billing-model').value=config.plan.billing.model;$('#billing-price').value=config.plan.billing.price;$('#billing-credit').value=config.plan.billing.credit;updateBillingFields();syncChoices();
  $('#cost-cpu').value = config.rates.cpuHour; $('#cost-ram').value = config.rates.ramGBHour; $('#cost-storage').value = config.rates.storageGBMonth; $('#cost-hours').value = config.rates.hours; $('#cost-gb').value = config.storageGB; $('#cost-dialog').showModal();
};
$('#cost-dialog').addEventListener('close', () => {
  closeChoice();
  if ($('#cost-dialog').returnValue !== 'apply') return;
  const price=Number($('#billing-price').value),credit=Number($('#billing-credit').value);
  if(![price,credit].every(n=>Number.isFinite(n)&&n>=0&&n<=1000000))return notice('Enter valid non-negative subscription and credit amounts.',true);
  config.plan.billing={model:$('#billing-model').value,price,credit};
  config.rates = { cpuHour: Number($('#cost-cpu').value), ramGBHour: Number($('#cost-ram').value), storageGBMonth: Number($('#cost-storage').value), hours: Number($('#cost-hours').value) };
  config.storageGB = Number($('#cost-gb').value);renderPlanInputs();rememberPlan();estimate();markDirty();notice('Cost assumptions updated. Prepare the stack to save them.');
});
function theme(mode) { document.documentElement.dataset.theme = mode; $('#theme').textContent = mode === 'light' ? 'Dark mode' : 'Light mode'; }
theme(localStorage.getItem('systems-lab-theme') || 'light');
$('#theme').onclick = () => { const mode = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; theme(mode); localStorage.setItem('systems-lab-theme', mode); };
window.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); action(saveProject, 'Workspace saved.'); } });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
$('#research-content').innerHTML = `<div class="research-prose"><h3>Less searching. More understanding.</h3><p>The core task is to choose a project, set a budget, run traffic, and understand failures. A stable sidebar keeps those steps recognizable; the inspector keeps settings beside the selected service.</p><h3>What studies with people found</h3><p><a href="https://edoc.unibas.ch/entities/publication/f42f4d7b-f955-4f70-befc-9540275c4be6" target="_blank" rel="noreferrer">Tuch et al. (2009)</a> studied 48 participants with 36 website screenshots, a visual search task, and delayed recognition. Greater complexity was associated with slower search and lower recognition. This is promising evidence for clear grouping, not proof that this developer tool is easier to use.</p><p><a href="https://edoc.unibas.ch/entities/publication/ebcfa3de-1a92-4195-b6fd-ab67d80af2aa" target="_blank" rel="noreferrer">Tuch et al. (2012)</a> had 80 participants find items in four versions of an online shop. Aesthetics did not improve perceived usability in this experiment; poor usability reduced post-use aesthetic ratings. A beautiful interface still needs working controls and useful errors.</p><h3>Apple-inspired, content first</h3><p><a href="https://developer.apple.com/design/human-interface-guidelines/materials" target="_blank" rel="noreferrer">Apple’s materials guidance</a> separates translucent navigation and controls from content. Here, glass is restrained to the sidebar and toolbar. Tables, code, and settings use solid surfaces.</p><h3>Accessibility and verification</h3><p><a href="https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html" target="_blank" rel="noreferrer">WCAG 2.2 target-size guidance</a> establishes a 24 CSS pixel minimum with exceptions; this app aims for larger controls, visible focus, and readable labels. Desktop, narrow screens, keyboard use, and error paths need direct verification.</p><p>No human usability test of Systems Lab has been conducted. A useful first test: ask a developer to cap PostgreSQL at 1 GiB, run 10 users, pause the API, identify the failure, and recover without help. If they cannot find a setting or understand a result, revise the layout.</p></div>`;
document.querySelectorAll('button[data-results-layout]').forEach(button=>button.onclick=()=>setResultsLayout(button.dataset.resultsLayout));
$('#pause-terminal').onclick=()=>{terminalPaused=!terminalPaused; $('#pause-terminal').textContent=terminalPaused?'Resume':'Pause'; $('#pause-terminal').setAttribute('aria-pressed',String(terminalPaused)); if(!terminalPaused)renderResults();};
for(const id of ['#terminal-search','#terminal-service','#terminal-level']) $(id).addEventListener(id==='#terminal-search'?'input':'change',()=>{terminalSignature=''; if(terminalPaused){notice('Resume terminal updates to apply new filters.');return;}renderResults();});
$('#issue-groups').onclick=event=>{const button=event.target.closest('[data-issue-service]');if(!button)return;terminalPaused=false;$('#pause-terminal').textContent='Pause';$('#pause-terminal').setAttribute('aria-pressed','false');$('#terminal-service').value=button.dataset.issueService;$('#terminal-level').value='issues';setResultsLayout(innerWidth<1000?'terminal':'split');terminalSignature='';renderResults();$('#event-log').focus();};
$('#copy-terminal').onclick=()=>action(async()=>{await navigator.clipboard.writeText(terminalVisible.map(line=>`${line.time} ${line.service} ${line.message}`).join('\n'));},'Visible terminal output copied.');
$('#download-terminal').onclick=()=>{const blob=new Blob([terminalVisible.map(line=>`${line.time} ${line.service} ${line.message}`).join('\n')],{type:'text/plain'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='systems-lab-output.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('#inspect-requests').onclick=()=>changeView('traffic'); $('#inspect-test').onclick=()=>changeView('scenario');
$('#prepare-smaller-run').onclick=()=>{const users=Math.max(1,Math.floor(Number(state.run.users || 10)/2));$('#users').value=users;$('#run-target').value=state.run.target==='project'?'project':'demo';updateScenario();notice(`Ready to compare ${users.toLocaleString()} users. Press Run test when ready; no test has started yet.`);$('#users').focus();};
setupCompactLayout();
upgradeChoices();
setResultsLayout(innerWidth < 1000 ? 'summary' : 'split');
window.addEventListener('resize',()=>{closeProjectMenus();if(innerWidth<1000&&resultsLayout==='split')setResultsLayout('summary');});
document.querySelectorAll('[data-workload]').forEach(input => input.addEventListener('input', () => { input.dataset.custom = 'true'; document.querySelector(`[data-reset-workload="${input.dataset.workload}"]`).hidden = false; document.querySelector(`[data-workload-source="${input.dataset.workload}"]`).textContent = 'Your custom value'; readWorkload(); $('#workload-save-state').textContent = 'Unsaved custom values'; markDirty(); }));
document.querySelectorAll('[data-edit-workload]').forEach(button => button.onclick = () => { const input = document.querySelector(`[data-workload="${button.dataset.editWorkload}"]`); input.readOnly = false; input.focus(); input.select(); button.textContent = 'Editing'; });
document.querySelectorAll('[data-reset-workload]').forEach(button => button.onclick = () => { workloads[config.projectPath][button.dataset.resetWorkload] = ''; renderWorkload(); markDirty(); $('#workload-save-state').textContent = 'Automatic value restored. Save to keep this change.'; });
$('#baseline-run').onclick = () => action(async () => {
  if (config.projectPath !== state.infra.config.projectPath || !state.infra.containers.some(c => (c.Service === 'nginx' || c.Service === config.definition?.entry) && c.State === 'running')) throw new Error('Start the selected app with Start stack first. Then run this small test.');
  await saveProject(); await api('/api/load', {users:10, ramp:5, duration:30, target:'project'});
}, 'Small project test started. Measured values will appear automatically when it finishes.');
$('#save-workload').onclick = () => action(saveWorkload, 'Custom values saved for this project.');
$('#project-picker').onclick = openProjectPicker;
$('#project-search').oninput = () => {renderProjectOptions(); positionDropdown('#project-picker','#project-picker-panel');};
$('#project-options').onclick = event => { const option = event.target.closest('[data-project-path]'); if (option) action(() => chooseLocalProject(option.dataset.projectPath)); };
$('#project-manual').onclick = () => { closeProjectMenus(); $('#project-path').focus(); $('#project-path').select(); };
$('#project-path').onchange = () => { if (workloadsLoaded) readWorkload(); readConfig(); renderWorkload(); markDirty(); renderInfraLive(); renderButtons(); };
$('#profile-picker').onclick = () => {
  const open = $('#profile-picker').getAttribute('aria-expanded') !== 'true'; closeProjectMenus();
  if (open) { $('#profile-picker').setAttribute('aria-expanded','true'); $('#profile-options').classList.remove('hidden'); positionDropdown('#profile-picker','#profile-options'); $('#profile-options [aria-selected="true"]')?.focus(); }
};
$('#profile-options').onclick = event => { const option = event.target.closest('[data-profile]'); if (!option) return; $('#project-mode').value = option.dataset.profile; $('#project-mode').dispatchEvent(new Event('change')); closeProjectMenus('#profile-picker'); markDirty(); renderInfraLive(); renderButtons(); };
document.addEventListener('click', event => { if (!event.target.closest('.dropdown,.choice-control,.select-menu')) closeProjectMenus(); });
document.addEventListener('keydown', event => {
  const projectOpen = $('#project-picker').getAttribute('aria-expanded') === 'true';
  const profileOpen = $('#profile-picker').getAttribute('aria-expanded') === 'true';
  if (!projectOpen && !profileOpen) return;
  if (event.key === 'Escape') { event.preventDefault(); closeProjectMenus(projectOpen ? '#project-picker' : '#profile-picker'); return; }
  const options = [...document.querySelectorAll(projectOpen ? '#project-options [role="option"]' : '#profile-options [role="option"]')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); const current = options.indexOf(document.activeElement);
    const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }
});
await refresh().catch(error => notice(error.message, true));
loadProjects().catch(() => {});
loadWorkloads().catch(error => notice(error.message, true));
setInterval(() => { if (!acting) refresh().catch(() => notice('Connection lost. Check that the local lab server is running.', true)); }, 1500);

$('#project-path').addEventListener('change',()=>action(async()=>{config.projectPath=$('#project-path').value.trim();delete config.definition;await detectProject();markDirty();}));
