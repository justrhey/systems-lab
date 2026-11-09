import path from 'node:path';
export function validateDefinition(def) {
  if (def?.version !== 1 || !def.services || Array.isArray(def.services) || Object.keys(def.services).length > 32) throw new Error('Use a version 1 systems-lab.json with up to 32 services.');
  for (const [id,s] of Object.entries(def.services)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) throw new Error(`Invalid service ID: ${id}`);
    if(s.kind!=='app' && (!['nginx','postgres','redis','kafka','rabbitmq','mongodb','mysql','minio','prometheus','grafana'].includes(s.kind)||id!==s.kind))throw new Error(`Unsupported service kind or ID: ${id}`);
    if (s.kind === 'app') {
      if (s.dockerfile != null && (typeof s.dockerfile !== 'string' || path.isAbsolute(s.dockerfile) || s.dockerfile.split(/[\\/]/).includes('..'))) throw new Error(`${id}: Dockerfile must be inside the project.`);
      if (s.command && (!Array.isArray(s.command) || !s.command.length || !s.command.every(v=>typeof v==='string'))) throw new Error(`${id}: command must be an argument array.`);
      if (s.port != null && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) throw new Error(`${id}: invalid HTTP port.`);
      for (const key of ['environment','buildArgs']) if (s[key] && (typeof s[key] !== 'object' || Array.isArray(s[key]) || !Object.values(s[key]).every(v=>typeof v==='string'))) throw new Error(`${id}: ${key} must contain string values.`);
      for (const key of ['target']) if(s[key] && !/^[a-zA-Z0-9_.-]+$/.test(s[key])) throw new Error(`${id}: invalid ${key}.`);
      if(s.volumes && (!Array.isArray(s.volumes)||!s.volumes.every(v=>/^[a-z][a-z0-9_-]*:\/[a-zA-Z0-9_./-]+$/.test(v)&&!v.split('/').includes('..')))) throw new Error(`${id}: use named volumes and absolute container paths.`);
    }
    if(s.dependsOn && (!Array.isArray(s.dependsOn)||!s.dependsOn.every(v=>typeof v==='string'&&Object.hasOwn(def.services,v)))) throw new Error(`${id}: dependencies must name defined services.`);
  }
  if(def.entry != null && !Object.hasOwn(def.services,def.entry)) throw new Error('Entry service is not defined.');
  return def;
}
export function addApplications(config, services, volumes, cap, secret) {
  const def=validateDefinition(config.definition), origin=`http://localhost:${config.entryPort}`;
  const substitutions={LAB_SECRET:secret,LAB_ENTRY_ORIGIN:origin,LAB_DATABASE_URL:`postgresql://lab:${secret}@postgres:5432/freshphones_lab`,LAB_REDIS_URL:`redis://:${secret}@redis:6379/0`};
  const expand=value=>value.replace(/\$\{([A-Z_]+)\}/g,(match,key)=>{if(!(key in substitutions))throw new Error(`Unknown lab placeholder: ${key}`);return substitutions[key];});
  for(const [id,s] of Object.entries(def.services)) {
    if(s.kind!=='app'||!config.resources[id]?.enabled)continue;
    if(!s.dockerfile)throw new Error(`${id}: set a Dockerfile in systems-lab.json. Detection does not invent build instructions.`);
    const data={build:{context:config.projectPath,dockerfile:s.dockerfile},...cap(id)};
    if(s.target)data.build.target=s.target;
    if(s.buildArgs)data.build.args=Object.fromEntries(Object.entries(s.buildArgs).map(([k,v])=>[k,expand(v)]));
    if(s.environment)data.environment=Object.fromEntries(Object.entries(s.environment).map(([k,v])=>[k,expand(v)]));
    else data.environment={HOST:'0.0.0.0',...(s.port?{PORT:String(s.port)}:{})};
    if(s.command)data.command=s.command;
    if(s.volumes){data.volumes=s.volumes;for(const v of s.volumes)volumes[v.split(':')[0]]={};}
    const dependencies=(s.dependsOn||[]).filter(dep=>config.resources[dep]?.enabled);
    if(dependencies.length)data.depends_on=Object.fromEntries(dependencies.map(dep=>[dep,{condition:def.services[dep]?.oneShot?'service_completed_successfully':['postgres','redis'].includes(dep)?'service_healthy':'service_started'}]));
    if(def.entry===id && s.port && !config.resources.nginx?.enabled)data.ports=[`127.0.0.1:${config.entryPort}:${s.port}`];
    services[id]=data;
  }
}
export function nginxConfig(config) {
  const def=config.definition;
  const routes=config.mode==='detected'?(def.routes||[{path:'/',service:def.entry}]):[{path:'/api/',service:'api',port:4100},{path:'/',service:'web',port:config.mode==='freshphones'?3000:config.appPort}];
  const locations=routes.filter(r=>r.service!=='nginx'&&config.resources[r.service]?.enabled).map(r=>{
    const port=r.port||def?.services[r.service]?.port;
    if(!/^\/[a-zA-Z0-9_/-]*$/.test(r.path)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Gateway routes need a valid path, service and port.');
    return `location ${r.path} { proxy_pass http://${r.service}:${port}; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; proxy_read_timeout 65s; }`;
  });
  if(!locations.some(l=>l.startsWith('location / {')))locations.push('location / { return 503; }');
  return `server { listen 80; server_name _; client_max_body_size 12m; ${locations.join(' ')} }\n`;
}
