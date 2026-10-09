import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {interruptDriver,prefixInventory,digest,validateInterruptedRestore} from './first-hop-interruption.mjs';
import {isTrustedHarnessOwnedUpgradeSurvivorScenario,supportsUpgradeSurvivorScenarioAtBaseline} from '../../../lib/upgrade-survivor-policy.mjs';

// Actual OS/process operations on fictional disposable data, not release proof.
const helper=fileURLToPath(new URL('first-hop-interruption.mjs',import.meta.url));
const preload=fileURLToPath(new URL('first-hop-interruption-preload.mjs',import.meta.url));
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'original-driver-boundary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const liveRoot=path.join(root,'prefix/lib/node_modules/openclaw');
  fs.mkdirSync(path.join(liveRoot,'dist'),{recursive:true});
  fs.writeFileSync(path.join(liveRoot,'package.json'),JSON.stringify({version:'2026.9.8'}));
  fs.writeFileSync(path.join(liveRoot,'dist/build-info.json'),JSON.stringify({version:'2026.9.8',commit:'fc23bc864e4553c2d215e479eeec47b67a0bf943'}));
  const directory=path.join(root,'evidence');fs.mkdirSync(directory);
  const destination=path.join(root,'retired');
  const config={runId:'fictional-boundary',fixtureRoot:root,liveRoot,baselineVersion:'2026.9.8',baselineSource:'fc23bc864e4553c2d215e479eeec47b67a0bf943',targetSha256:'fictional-target'};
  const env={...process.env,NODE_OPTIONS:`--import=${preload}`};
  const driver=path.join(root,'original-driver.mjs');
  fs.writeFileSync(driver,`import fs from 'node:fs/promises';await fs.rename(${JSON.stringify(liveRoot)},${JSON.stringify(destination)});await fs.writeFile(${JSON.stringify(path.join(root,'candidate-publication'))},'must never execute');`);
  return {root,directory,destination,config,env,driver};
}
test('real displacement then external SIGKILL; never candidate publication or fabricated ledger',async t=>{
  const f=fixture(t),before=prefixInventory(f.config.liveRoot);
  const r=await interruptDriver({argv:[f.driver],...f,timeoutMs:2000});
  assert.equal(r.terminal.signal,'SIGKILL');assert.equal(r.parentJoined,true);
  assert.deepEqual(r.liveProcessesAfter,[]);assert.equal(r.marker.retiredRoot,f.destination);
  assert(!fs.existsSync(f.config.liveRoot));assert(!fs.existsSync(path.join(f.root,'candidate-publication')));
  assert.equal(prefixInventory(f.destination),before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'terminal-observation.json'))).cleanupError,null);
});
for(const failure of ['wrong-version','wrong-source','symlink-parent','missing-boundary','early-success']) test(`refuse ${failure}, bounded cleanup and no displaced prefix`,async t=>{
  const f=fixture(t);
  if(failure==='wrong-version')fs.writeFileSync(path.join(f.config.liveRoot,'package.json'),'{"version":"2026.9.4"}');
  if(failure==='wrong-source')f.config.baselineSource='wrong-original-source';
  if(failure==='symlink-parent'){
    const external=fs.mkdtempSync(path.join(os.tmpdir(),'external-boundary-'));t.after(()=>fs.rmSync(external,{recursive:true,force:true}));
    const alias=path.join(f.root,'alias');fs.symlinkSync(external,alias);
    fs.writeFileSync(f.driver,`import fs from 'node:fs/promises';await fs.rename(${JSON.stringify(f.config.liveRoot)},${JSON.stringify(path.join(alias,'retired'))});`);
  }
  if(failure==='missing-boundary')fs.writeFileSync(f.driver,'setInterval(()=>{},1000)');
  if(failure==='early-success')fs.writeFileSync(f.driver,'process.exit(0)');
  await assert.rejects(interruptDriver({argv:[f.driver],...f,timeoutMs:150}));
  assert(fs.existsSync(f.config.liveRoot));assert(!fs.existsSync(f.destination));
  const terminal=JSON.parse(fs.readFileSync(path.join(f.directory,'terminal-observation.json')));
  assert.equal(terminal.cleanupError,null);assert(terminal.terminal);
});
test('controller SIGTERM joins and kills its owned updater; no retry',async t=>{
  const f=fixture(t);fs.writeFileSync(f.driver,'setInterval(()=>{},1000)');
  const controller=path.join(f.root,'controller.mjs');
  fs.writeFileSync(controller,`import {interruptDriver} from ${JSON.stringify(new URL('first-hop-interruption.mjs',import.meta.url).href)};await interruptDriver(${JSON.stringify({argv:[f.driver],env:f.env,config:f.config,directory:f.directory,timeoutMs:2000})});`);
  const child=spawn(process.execPath,[controller],{stdio:'ignore'});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  const until=Date.now()+2000;
  while(!fs.existsSync(path.join(f.directory,'started.json'))&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert(fs.existsSync(path.join(f.directory,'started.json')));child.kill('SIGTERM');
  const result=await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>{child.kill('SIGKILL');reject(Error('controller did not join'));},4000).unref())]);
  assert.notEqual(result.code,0);
  const terminal=JSON.parse(fs.readFileSync(path.join(f.directory,'terminal-observation.json')));
  assert.equal(terminal.controllerSignal,'SIGTERM');assert.equal(terminal.cleanupError,null);
  assert(fs.existsSync(f.config.liveRoot));
});
test('inventory detects dependency, mode and symlink-target differences',t=>{
  const f=fixture(t);const original=prefixInventory(f.root);
  fs.writeFileSync(path.join(f.config.liveRoot,'dependency'),'different');assert.notEqual(prefixInventory(f.root),original);
});
test('scenario is explicit trusted owner and exact9.8 only; historical guards stay separate',()=>{
  assert(isTrustedHarnessOwnedUpgradeSurvivorScenario('first-hop-interruption'));
  assert(supportsUpgradeSurvivorScenarioAtBaseline('first-hop-interruption','openclaw@2026.9.8'));
  for(const b of ['openclaw@2026.9.3','openclaw@2026.9.4','openclaw@2026.9.9'])assert(!supportsUpgradeSurvivorScenarioAtBaseline('first-hop-interruption',b));
  assert(supportsUpgradeSurvivorScenarioAtBaseline('abandoned-update','openclaw@2026.9.3'));
  assert(!supportsUpgradeSurvivorScenarioAtBaseline('abandoned-update','openclaw@2026.9.8'));
});

test('retained interruption evidence binds immutable intent/capture/marker/prefix and refuses detached records',async t=>{
  const f=fixture(t);
  const directory=path.join(f.root,'artifacts/first-hop-interruption');fs.mkdirSync(directory,{recursive:true});
  const retainedPrefix=path.join(f.root,'retained-prefix');fs.cpSync(path.join(f.root,'prefix'),retainedPrefix,{recursive:true});
  const proofPath=path.join(f.root,'artifacts/backup.json');
  const proof={runtime:{manifestSha256:digest(path.join(f.config.liveRoot,'package.json')),entrySha256:digest(f.driver)},archive:{sha256:'fictional-backup'},sourceStateDir:path.join(f.root,'state')};
  fs.writeFileSync(proofPath,JSON.stringify(proof));const capturedProofPath=path.join(directory,'captured-backup.json');fs.copyFileSync(proofPath,capturedProofPath);
  const fields={runId:f.config.runId,originalEntry:f.driver,originalEntrySha256:proof.runtime.entrySha256,node:{version:process.version,executable:process.execPath},proofPath,backupProofSha256:digest(proofPath),targetSha256:'acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470',originalPackageRoot:f.config.liveRoot,sourceStateDir:proof.sourceStateDir,configRelative:'openclaw.json',configSha256:'fictional-config',retainedPrefix,originalPrefixSha256:prefixInventory(retainedPrefix),companionManifestSha256:'1e52816586e4cf01d1d469228027b28e769e6eb6e53518a1e8ffc17b64bdbbee'};
  const intentPath=path.join(directory,'intent.json');fs.writeFileSync(intentPath,JSON.stringify({...fields,target:'fictional-unchanged-target.tgz'}));
  const config={...f.config,targetSha256:fields.targetSha256};
  const observed=await interruptDriver({argv:[f.driver,'update','--tag','fictional-unchanged-target.tgz','--yes','--json','--no-restart','--channel','stable'],env:f.env,config,directory,timeoutMs:2000});
  const result={...fields,...observed,originalEntry:f.driver,capturedProofPath,intentSha256:digest(intentPath),schema:'openclaw.first-hop-interruption.v1',outcome:'interrupted-not-upgraded',baselineSource:config.baselineSource,baselineVersion:'2026.9.8',targetSource:'ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2',retainedManifestSha256:proof.runtime.manifestSha256,originalEntrySha256:proof.runtime.entrySha256,backupArchiveSha256:proof.archive.sha256,markerPath:path.join(directory,'boundary.json')};
  const previous=process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT=f.root;
  try {
    assert.equal(validateInterruptedRestore(proof,result,proofPath),result);
    for(const [field,value] of Object.entries({originalEntry:'different-original',originalEntrySha256:'detached-entry',node:{version:'wrong'},runId:'foreign',backupProofSha256:'changed',targetSha256:'changed',baselineVersion:'2026.9.4',targetSource:'wrong-product',companionManifestSha256:'changed',markerSha256:'changed',parentJoined:false,liveProcessesAfter:[123],backupArchiveSha256:'changed',originalPrefixSha256:'changed',intentSha256:'changed'})) {
      const r=structuredClone(result);r[field]=value;assert.throws(()=>validateInterruptedRestore(proof,r,proofPath),field);
    }
    fs.writeFileSync(path.join(retainedPrefix,'unexpected-dependency'),'tampered');assert.throws(()=>validateInterruptedRestore(proof,result,proofPath));
  } finally {if(previous===undefined)delete process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;else process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT=previous;}
});

import {publishedBackupRollback} from './backup-rollback-summary.mjs';
test('published interruption summary preserves original9.8 identity and refuses successful-candidate relabeling',()=>{
 const h='a'.repeat(64), runtime={version:'2026.9.8',manifestSha256:h,entrySha256:h,schemaVersions:{state:19,agent:24}};
 const proof={status:'passed',baselineVersion:'2026.9.8',candidateVersion:'2026.9.9',interruptionSha256:h,runtime,archive:{sha256:h},before:{databases:[{kind:'state',present:true,userVersion:19,contentVersion:19,sessions:[],tables:[]},{kind:'agent',agentId:'main',present:true,userVersion:24,contentVersion:24,sessions:[{key:'fictional',sessionId:'fictional'}],tables:[{table:'transcript_events',rows:1,sha256:h}]}],files:[{kind:'transcript',sha256:h}]},preflights:[{agentId:'main',status:'exact',foundVersion:24,targetVersion:24}],sessionReads:[{agentId:'main',count:1}]};
 const snapshot={scenario:'first-hop-interruption',baseline:{spec:'openclaw@2026.9.8',version:'2026.9.8'},candidate:{version:'2026.9.9'},installedVersion:'2026.9.8',updateRestartMode:'manual',updateOutcome:'interrupted-baseline-restored',backupRollback:proof,
 firstHopInterruption:{schema:'openclaw.first-hop-interruption.v1',outcome:'interrupted-not-upgraded',baselineVersion:'2026.9.8',baselineSource:'fc23bc864e4553c2d215e479eeec47b67a0bf943',targetSource:'ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2',targetSha256:'acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470',parentJoined:true,liveProcessesAfter:[],terminal:{signal:'SIGKILL'},marker:{boundary:'after-original-prefix-rename-before-candidate-publication'},backupProofSha256:h,markerSha256:h,intentSha256:h,originalPrefixSha256:h},
 backupRollbackRestart:{status:'passed',baselineVersion:'2026.9.8',runtime,capturedBackupSha256:h,interruptionSha256:h}};
 const io={sanitize:v=>v,boundedList:v=>{assert(Array.isArray(v));return v;},textFields:()=>({})};
 const result=publishedBackupRollback(snapshot,io);assert.equal(result.interruption.candidateActivated,false);assert.equal(result.interruption.restoredOriginalRestart,'passed');assert.equal(result.candidateSchemaVersions,undefined);
 for(const mutate of [s=>s.installedVersion='2026.9.9',s=>s.updateOutcome='success',s=>delete s.backupRollbackRestart,s=>s.firstHopInterruption.parentJoined=false,s=>s.firstHopInterruption.liveProcessesAfter=[123],s=>s.firstHopInterruption.terminal.signal=null,s=>s.backupRollbackRestart.capturedBackupSha256='b'.repeat(64),s=>s.backupRollback.interruptionSha256='b'.repeat(64),s=>s.backupRollback.candidateVersion='2026.9.8',s=>s.backupRollback.preflights=[],s=>s.backupRollback.before.databases[1].tables=[]]){const bad=structuredClone(snapshot);mutate(bad);assert.throws(()=>publishedBackupRollback(bad,io));}
});
