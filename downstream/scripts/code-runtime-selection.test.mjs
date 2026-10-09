import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, mkdtemp, symlink, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CODE_SELECTION, runtimeSelectionPaths, validateCodeSelection} from './validate-packaged-candidate.mjs';
import {validateCurrentHostRecords} from './validate-current-host-image-inputs.mjs';
import {validateInstalledPluginRuntime} from './validate-installed-plugin-runtime.mjs';

// Fictional byte fixtures exercise the contract, not product/runtime qualification.
const sha = b => createHash('sha256').update(b).digest('hex');
const platformBytes = Buffer.from(JSON.stringify({name:'@openai/codex',version:'0.160.0-linux-x64',os:['linux'],cpu:['x64']}));
const binaryBytes = Buffer.from('fictional Linux binary');
const engine = 'node_modules/@openclaw/codex/node_modules/@openai/codex';
const platform = `${engine}/node_modules/@openai/codex-linux-x64`;
const hostLock = {packages:{'node_modules/openclaw':{version:'2026.9.9',resolved:'file:../tmp/openclaw-current.tgz',integrity:'fixture-host-integrity'}}};
const dependencies = {'@openclaw/codex':'file:../../tmp/codex-current.tgz',openclaw:'file:/app/node_modules/openclaw'};
const pluginLock = {name:'openclaw-nas-plugin-runtime',lockfileVersion:3,packages:{'':{dependencies},
  'node_modules/@openclaw/codex':{version:'2026.9.9',integrity:`sha512-${Buffer.alloc(64).toString('base64')}`},
  'node_modules/openclaw':{link:true,resolved:'../../app/node_modules/openclaw'},
  [engine]:{version:'0.160.0'},[platform]:{version:'0.160.0-linux-x64',os:['linux'],cpu:['x64'],integrity:`sha512-${Buffer.alloc(64).toString('base64')}`}}};
const candidate = {role:'code',platform:'linux/amd64',hostVersion:'2026.9.9',hostProducedFrom:CODE_SELECTION.source,hostArchiveSha256:CODE_SELECTION.archive,
  hostRunId:37873292633,hostRunCommit:'6527403cfe201d0508450ad39c0a985599f2c8b3',hostArtifactId:11591748081,
  hostArtifactDigest:'sha256:ee26e271682091ca442d6caa2211adb89a03aeed3f9f34bb70bc8d9680f87559',
  companionManifestSha256:CODE_SELECTION.registryManifest,companionSourceSha:CODE_SELECTION.source,
  companionArtifact:{id:1,runId:1,headSha:'1'.repeat(40),digest:'sha256:'+'2'.repeat(64),name:'fictional',sizeBytes:15383940},
  components:{codex:{version:'2026.9.9',engineVersion:'0.160.0',sha256:CODE_SELECTION.companion}},
  codexPlatform:{packageVersion:'0.160.0-linux-x64',manifestSha256:sha(platformBytes),binarySha256:sha(binaryBytes),binaryRelativePath:'vendor/x86_64-unknown-linux-gnu/codex/codex'},
  locks:{'host.package-lock.json':sha(JSON.stringify(hostLock)),'plugins.package-lock.json':sha(JSON.stringify(pluginLock))}};
const actual = {build:{version:candidate.hostVersion,commit:candidate.hostProducedFrom},hostSha256:candidate.hostArchiveSha256,
  hostIntegrity:hostLock.packages['node_modules/openclaw'].integrity,codexSha256:CODE_SELECTION.companion,codexIntegrity:pluginLock.packages['node_modules/@openclaw/codex'].integrity};

test('Code selection admits exact 9.9 product without CC; paired remains the default', () => {
  assert.equal(validateCodeSelection(candidate),candidate);
  assert.equal(validateCurrentHostRecords(candidate,hostLock,pluginLock,actual),candidate);
  assert.equal(runtimeSelectionPaths().target,'runtime');
  assert.equal(runtimeSelectionPaths('code').target,'code-runtime');
  assert.throws(()=>runtimeSelectionPaths('life-ish'));
});
for (const [name, mutate] of Object.entries({
  role:c=>c.role='life',arch:c=>c.platform='linux/arm64',version:c=>c.hostVersion='2026.9.8',source:c=>c.hostProducedFrom='0'.repeat(40),
  archive:c=>c.hostArchiveSha256='0'.repeat(64),producer:c=>c.hostArtifactId++,companion:c=>c.components.codex.sha256='0'.repeat(64),
  engine:c=>c.components.codex.engineVersion='0.158.0',registry:c=>c.companionManifestSha256='0'.repeat(64),
  CC:c=>c.commandCenter={},platform:c=>c.codexPlatform.packageVersion='0.158.0-linux-x64',traversal:c=>c.codexPlatform.binaryRelativePath='../codex',
  size:c=>c.companionArtifact.sizeBytes=64*1024*1024+1,
  extra:c=>c.components.qmd={},locks:c=>delete c.locks['host.package-lock.json'],missingRegistry:c=>delete c.companionArtifact,
})) test(`Code rejects detached ${name}`,()=>{const c=structuredClone(candidate);mutate(c);assert.throws(()=>validateCodeSelection(c));});
for(const [name,mutate] of Object.entries({engine:p=>p.packages[engine].version='0.158.0',platform:p=>p.packages[platform].version='0.158.0-linux-x64',arch:p=>p.packages[platform].cpu=['arm64'],peer:p=>p.packages['node_modules/openclaw'].resolved='/registry-host'})) {
  test(`Code rejects old or wrong lock ${name}`,()=>{const p=structuredClone(pluginLock);mutate(p);assert.throws(()=>validateCurrentHostRecords(candidate,hostLock,p,actual));});
}
for(const failure of [null,'binary','manifest','lock','host','engine']) test(`installed Code graph bytes: ${failure??'matching'}`,async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'code-graph-'));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const root=path.join(tmp,'plugins'),host=path.join(tmp,'app/node_modules/openclaw');
  const put=async(file,bytes)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);};
  await put(path.join(root,'package.json'),JSON.stringify({name:pluginLock.name,dependencies}));
  await put(path.join(root,'package-lock.json'),JSON.stringify(pluginLock));
  await put(path.join(tmp,'app/package-lock.json'),JSON.stringify(hostLock));
  await put(path.join(root,'node_modules/@openclaw/codex/package.json'),JSON.stringify({name:'@openclaw/codex',version:'2026.9.9'}));
  await put(path.join(root,engine,'package.json'),JSON.stringify({version:failure==='engine'?'0.158.0':'0.160.0'}));
  await put(path.join(root,platform,'package.json'),failure==='manifest'?Buffer.from('{}'):platformBytes);
  await put(path.join(root,platform,candidate.codexPlatform.binaryRelativePath),failure==='binary'?Buffer.from('tampered'):binaryBytes);
  await put(path.join(host,'dist/build-info.json'),JSON.stringify({...actual.build,commit:failure==='host'?'0'.repeat(40):candidate.hostProducedFrom}));
  if(failure==='lock')await put(path.join(root,'package-lock.json'),JSON.stringify({...pluginLock,extra:true}));
  await mkdir(path.join(root,'node_modules/@openclaw/codex/node_modules'),{recursive:true});
  await symlink(host,path.join(root,'node_modules/openclaw'));await symlink(host,path.join(root,'node_modules/@openclaw/codex/node_modules/openclaw'));
  if(failure)await assert.rejects(validateInstalledPluginRuntime(root,host,candidate));else await validateInstalledPluginRuntime(root,host,candidate);
});
