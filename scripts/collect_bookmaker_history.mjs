// Scheduled GitHub job only: persists sanitized public observations to a data-only
// branch. The website has no write endpoint and never receives this job's token.
import {readFile} from 'node:fs/promises';
import {BOOKMAKERS} from '../bookmakers.js';
import {emptyDay, mergeDay, moscowDay, validDay, normalizeDay} from '../assets/bookmaker-history.js';

export async function persistObservations(observations, api, now = Date.now()) {
  const branch = 'bookmaker-history';
  const ref = await api('GET','git/ref/heads/' + branch,undefined,true);
  const parent = ref?.object?.sha;
  const commit = parent ? await api('GET','git/commits/' + parent) : null;
  const days = new Set([moscowDay(now)]);
  for (const o of observations) for (const e of o?.events || []) {
    if (Number.isFinite(e.start) && Math.abs(e.start-now) < 60*86400000) days.add(moscowDay(e.start));
  }
  const tree = [];
  for (const day of [...days].filter(validDay).sort()) {
    const path = 'days/' + day + '.json';
    const stored = parent ? await api('GET','contents/' + path + '?ref=' + parent,undefined,true) : null;
    let value = stored ? normalizeDay(JSON.parse(Buffer.from(stored.content,'base64').toString('utf8')),day) : emptyDay(day);
    for (const o of observations) if (BOOKMAKERS.some(b => b.id === o?.id)) value = mergeDay(value,o,now);
    tree.push({path,mode:'100644',type:'blob',content:JSON.stringify(value,null,2)+'\n'});
  }
  if (!tree.length) return;
  const nextTree = await api('POST','git/trees',{...(commit ? {base_tree:commit.tree.sha} : {}),tree});
  const next = await api('POST','git/commits',{message:'Record public CyberClash lines ' + new Date(now).toISOString(),tree:nextTree.sha,parents:parent ? [parent] : []});
  // One scheduled writer (workflow concurrency). Never force over a newer writer.
  if (parent) await api('PATCH','git/refs/heads/' + branch,{sha:next.sha,force:false});
  else await api('POST','git/refs',{ref:'refs/heads/' + branch,sha:next.sha});
  return {sha:next.sha,days:[...days]};
}
if (process.argv[1]?.endsWith('/collect_bookmaker_history.mjs') || process.argv[1] === 'scripts/collect_bookmaker_history.mjs') {
  const token = process.env.GH_TOKEN;
  if (!token) throw Error('GitHub job token is required');
  const observations = JSON.parse(await readFile('work/bookmaker-observations.json','utf8'));
  if (!Array.isArray(observations) || observations.length > BOOKMAKERS.length) throw Error('Invalid public observations');
  const root='https://api.github.com/repos/ssolutionn/Oneshot-Panel/';
  const api=async(method,path,body,missing=false)=>{
    const r=await fetch(root+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
        'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(missing && r.status===404)return null;
    if(!r.ok)throw Error('GitHub archive request failed: '+r.status);
    return r.json();
  };
  console.log('ARCHIVE_SAVED',JSON.stringify(await persistObservations(observations,api)));
}
