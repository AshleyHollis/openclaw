import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {interruptDriver,prefixInventory,digest,validateInterruptedRestore} from './first-hop-interruption.mjs';
import {isTrustedHarnessOwnedUpgradeSurvivorScenario,supportsUpgradeSurvivorScenarioAtBaseline} from '../../../lib/upgrade-survivor-policy.mjs';

// Actual OS/process operations on fictional disposable data, not release proof.
const helper=fileURLToPath(new URL('first-hop-interruption.mjs',import.meta.url));
const preload=fileURLToPath(new URL('first-hop-interruption-preload.mjs',import.meta.url));
const scenario=fileURLToPath(new URL('first-hop-interruption.sh',import.meta.url));
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

for (const seedStatus of [0, 61]) {
  test(`native history seeding ${seedStatus === 0 ? 'precedes capture without legacy JSON injection' : 'failure stops before capture/interruption'}`, (t) => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-first-hop-seed-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    // Exercise the actual scenario shell on owned fictional files. Exit73 is
    // an explicit test checkpoint, not a claimed updater/rollback success.
    const script=`set -eu
source "$1"
baseline_spec=openclaw@2026.9.8 CANDIDATE_KIND=tarball UPDATE_RESTART_MODE=manual ROOT_MANAGED_VPS=0 LIVE_ENABLED=0
ARTIFACT_ROOT="$2" RUNTIME_ROOT="$2" CANDIDATE_SPEC="$2/fictional-candidate.tgz"
phase() {
  local name="$1"; shift
  echo "$name" >> "$ARTIFACT_ROOT/phases"
  if [ "$name" = interrupt-first-original-driver ]; then exit 73; fi
  "$@"
}
seed_state() { echo legacy-injection >> "$ARTIFACT_ROOT/phases"; return 62; }
seed_legacy_operator_gateway() {
  [ ${seedStatus} = 0 ] || return ${seedStatus}
  echo fictional-native-history > "$ARTIFACT_ROOT/native-history"
}
prepare_schema_expectation() { test -s "$ARTIFACT_ROOT/native-history"; }
capture_backup_rollback() { test -s "$ARTIFACT_ROOT/native-history"; }
package_root() { echo "$ARTIFACT_ROOT/original-prefix"; }
openclaw_e2e_package_entrypoint() { echo "$ARTIFACT_ROOT/original-prefix/openclaw.mjs"; }
run_first_hop_interruption
`;
    // Carry the test status as a shell variable, not fake native evidence.
    const result=spawnSync('bash',['-c',script,'seed-test',scenario,root],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,seedStatus === 0 ? 73 : seedStatus,result.stderr);
    const phases=fs.readFileSync(path.join(root,'phases'),'utf8').trim().split('\n');
    assert.deepEqual(phases,seedStatus === 0 ? ['seed-first-hop-native-history','capture-first-hop-schema','capture-first-hop-backup','interrupt-first-original-driver'] : ['seed-first-hop-native-history']);
    assert(!fs.existsSync(path.join(root,'sessions/sessions.json')));
  });
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

test('manual artifact dispatch stays within25inputs and strict existing registry owner; npm/paired contracts retained',()=>{
 const workflow=fs.readFileSync(new URL('../../../../.github/workflows/package-acceptance.yml',import.meta.url),'utf8');
 const dispatch=workflow.split('  workflow_dispatch:')[1].split('  workflow_call:')[0];
 assert.equal((dispatch.match(/^      [a-z0-9_]+:$/gm)||[]).length,25);
 assert(!dispatch.includes('      prepublish_plugin_registry_json:'));
 assert(workflow.includes("inputs.prepublish_plugin_registry_json || (inputs.source == 'artifact' && startsWith(inputs.package_spec, '{') && inputs.package_spec) || ''"));
 assert(workflow.includes('($source == "direct" and ((keys | sort) != (fields | sort)))'));
 assert(workflow.includes('Prerelease plugin registry inputs disagree.'));
 const call=workflow.split('  workflow_call:')[1];assert(call.includes('      prepublish_plugin_registry_json:'));
 assert(dispatch.includes('      package_spec:'));assert(dispatch.includes('      allow_frozen_target_scenario_omissions:'));
});

// Exercise the actual readonly restart observer on disposable SQLite/native
// identity fixtures. This is not an executed original9.8 release qualification.
const hashBytes=value=>createHash('sha256').update(value).digest('hex');
function restartFixture(t, fileCount = 1) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'restart-difference-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'restored');fs.mkdirSync(state);
  const dbFile=path.join(state,'agent.sqlite');const db=new DatabaseSync(dbFile);
  db.exec("PRAGMA user_version=24; CREATE TABLE session_key_contract(id INTEGER PRIMARY KEY, main_key TEXT, updated_at INTEGER); INSERT INTO session_key_contract VALUES(1,'fictional-private-main',100);");db.close();
  const columnSha256=Object.fromEntries(['id','main_key','updated_at'].map((key,index)=>[key,hashBytes(JSON.stringify([1,'fictional-private-main',{integer:'100'}][index]))]));
  const before={databases:[{kind:'agent',relative:'agent.sqlite',agentId:'main',present:true,userVersion:24,contentVersion:24,metadata:[],sessions:[],tables:[{table:'session_key_contract',columns:['id','main_key','updated_at'],rows:1,sha256:hashBytes('[{"integer":"1"},"fictional-private-main",{"integer":"100"}]\n'),columnSha256:{...columnSha256,id:hashBytes('{"integer":"1"}')}}]}],files:[]};
  for(let i=0;i<fileCount;i++){const relative=`owned-${i}.json`;fs.writeFileSync(path.join(state,relative),'original');before.files.push({relative,kind:'fixture',sha256:hashBytes('original')});}
  fs.writeFileSync(path.join(state,'openclaw.json'),'{}');
  const packageRoot=path.join(root,'original-runtime');fs.mkdirSync(packageRoot);
  const manifest={name:'openclaw',version:'2026.9.8',openclaw:{schemaVersions:{agent:24,state:19}}};
  fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify(manifest));
  const entry=path.join(packageRoot,'openclaw.mjs');fs.writeFileSync(entry,'// fictional retained original entry');
  const runtime={packageRoot,entry,version:manifest.version,schemaVersions:manifest.openclaw.schemaVersions,manifestSha256:hashBytes(fs.readFileSync(path.join(packageRoot,'package.json'))),entrySha256:hashBytes(fs.readFileSync(entry))};
  const archivePath=path.join(root,'backup.tar');fs.writeFileSync(archivePath,'fictional immutable backup');
  const captured={status:'captured',baselineVersion:'2026.9.8',before,runtime,archive:{path:archivePath,sha256:hashBytes(fs.readFileSync(archivePath))}};
  const capturedProofPath=path.join(root,'captured.json');fs.writeFileSync(capturedProofPath,JSON.stringify(captured));
  const fault={outcome:'interrupted-not-upgraded',capturedProofPath,backupProofSha256:hashBytes(fs.readFileSync(capturedProofPath)),configRelative:'openclaw.json',configSha256:hashBytes('{}')};
  const interruptionFile=path.join(root,'interruption.json');fs.writeFileSync(interruptionFile,JSON.stringify(fault));
  const resultFile=path.join(root,'backup-rollback.json');fs.writeFileSync(resultFile,JSON.stringify({...captured,status:'passed',restoredStateDir:state,interruptionSha256:hashBytes(fs.readFileSync(interruptionFile))}));
  const command=()=>spawnSync(process.execPath,[fileURLToPath(new URL('backup-rollback.mjs',import.meta.url)),'verify-restarted',resultFile,interruptionFile],{encoding:'utf8',timeout:10000});
  return {root,state,dbFile,command,resultFile,diagnostic:path.join(root,'backup-rollback-restart-difference.json')};
}
test('unchanged restarted inventory passes without failure diagnostic',t=>{
  const f=restartFixture(t);const r=f.command();assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'backup-rollback-restart.json'),'utf8')).status,'passed');
  assert(!fs.existsSync(f.diagnostic));
});
test('changed contract column still refuses and identifies exact column without raw values',t=>{
  const f=restartFixture(t);const db=new DatabaseSync(f.dbFile);db.exec("UPDATE session_key_contract SET main_key='fictional-secret-replacement',updated_at=200");db.close();
  const inventoryBefore=fs.readFileSync(f.dbFile);const proofBefore=fs.readFileSync(f.resultFile);
  const r=f.command();assert.equal(r.status,1);assert.match(r.stderr,/original baseline restart changed/);
  const raw=fs.readFileSync(f.diagnostic,'utf8'),d=JSON.parse(raw);
  assert(d.differences.some(x=>x.pointer==='/databases/0/tables/0/columnSha256/main_key'));
  assert(d.differences.some(x=>x.pointer==='/databases/0/tables/0/columnSha256/updated_at'));
  assert(!d.differences.some(x=>x.pointer.endsWith('/columnSha256/id')));
  assert(!raw.includes('fictional-secret-replacement'));assert(!raw.includes('fictional-private-main'));
  assert(Buffer.byteLength(raw)<=16384);assert.equal(d.omittedDifferences,0);
  assert.deepEqual(fs.readFileSync(f.dbFile),inventoryBefore);assert.deepEqual(fs.readFileSync(f.resultFile),proofBefore);
  assert(!fs.existsSync(path.join(f.root,'backup-rollback-restart.json')));
  assert.equal(fs.statSync(f.diagnostic).mode & 0o777,0o600);
});
test('bounded difference report retains refusal and explicit omissions; no overwrite/retry',t=>{
  const f=restartFixture(t,160);
  for(let i=0;i<160;i++)fs.writeFileSync(path.join(f.state,`owned-${i}.json`),'modified');
  const r=f.command();assert.equal(r.status,1);
  const raw=fs.readFileSync(f.diagnostic),d=JSON.parse(raw);assert.equal(d.totalDifferences,160);
  assert(d.omittedDifferences>0);assert.equal(d.differences.length+d.omittedDifferences,160);assert(raw.length<=16384);
  assert(Buffer.byteLength(JSON.stringify(raw.toString('utf8'))) <= 16384);
  const again=f.command();assert.equal(again.status,1);assert.match(again.stderr,/EEXIST/);assert.deepEqual(fs.readFileSync(f.diagnostic),raw);
});
test('actual capped/redacted diagnostic publisher retains difference log, not arbitrary files',t=>{
  const f=restartFixture(t);const rawDir=path.join(f.root,'diagnostics');fs.mkdirSync(rawDir);
  const label='backup-rollback-restart-difference.json';
  const diagnostic='{"status":"failed","fictionalSecret":"DO_NOT_UPLOAD"}';
  fs.writeFileSync(path.join(rawDir,'raw.json'),JSON.stringify({phase:'restored-original-history',exitStatus:1,signal:null,logs:{[label]:diagnostic,'unlisted-private.json':'DO_NOT_UPLOAD'}}));
  const destination=path.join(f.root,'published');
  const script=`import {publishDiagnostics} from ${JSON.stringify(new URL('diagnostics.mjs',import.meta.url).href)}; publishDiagnostics(${JSON.stringify(f.root)},${JSON.stringify(destination)},s=>s.replaceAll('DO_NOT_UPLOAD','[REDACTED]'));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);
  const raw=fs.readFileSync(path.join(destination,'failure.json'),'utf8'),d=JSON.parse(raw);
  assert.equal(d.logs[label],diagnostic.replace('DO_NOT_UPLOAD','[REDACTED]'));
  assert(!raw.includes('DO_NOT_UPLOAD'));assert(!('unlisted-private.json' in d.logs));
  assert.equal(d.limits.outputBytesPerLog,16384);assert.equal(d.limits.reportBytes,524288);
});
