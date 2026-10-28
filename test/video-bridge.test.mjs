import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile, mkdir, symlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const ORIGIN = 'https://api.surplusintelligence.ai';
const MODEL = 'longcat-distilled-image-to-video';
const KEY = 'inf_offline_test_key';
const TOKEN = 'private-job-token';
const SI_ID = 'si_job_1';
const MARKER = '.video-bridge-initialized';
const MARKER_BYTES = 'video-bridge-v1\n';
const clock = 1_800_000_000_000;
const quote = () => ({kind:'video', upstreamModel:MODEL, provider:'api.venice.ai', policyExpiresAt:new Date(clock+60_000).toISOString(), media:{parameters:{duration_seconds:5,resolution:'720p'}}});
const body = (id='request-1') => ({model:MODEL,prompt:'Move the clouds',duration:'5s',image_url:'https://images.example.com/source.png',_requestId:id});
const accepted = () => Response.json({id:SI_ID,status:'queued',job_token:TOKEN,poll_url:'https://evil.example/leak',cancel_url:'https://evil.example/cancel',estimated_cost_usdc:'14400',max_cost_usdc:'20000'},{status:202});
async function fixture(t, fetchImpl, config={}) {
  const root=join(homedir(),'.hermes-next','cache','scratch');
  await mkdir(root,{recursive:true,mode:0o700});
  const stateDir=await mkdtemp(join(root,'video-bridge-test-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const module=await import('../lib/video-bridge.mjs').catch(()=>({}));
  assert.equal(typeof module.createVideoBridge,'function','createVideoBridge must be exported');
  const events=[];
  const {artifactHosts=[],lookup,...videoBridgeConfig}=config;
  const options={settings:{stateDir,surplusBaseUrl:`${ORIGIN}/v1`,videoBridgeConfig,mediaArtifactHosts:artifactHosts,...(lookup?{mediaArtifactLookup:lookup}:{})},apiKey:KEY,fetchImpl,onEvent:event=>events.push(event),now:()=>clock};
  return {bridge:module.createVideoBridge(options),restart:()=>module.createVideoBridge(options),stateDir,events,options};
}

test('queue journals intent before submit, translates fixed parameters and returns only opaque native acceptance',async t=>{
  let context,calls=0;
  context=await fixture(t,async(url,init)=>{
    calls++;
    const saved=JSON.parse(await readFile(join(context.stateDir,'video-bridge','journal.json'),'utf8'));
    const intent=Object.values(saved.jobs)[0];
    assert.equal(intent.state,'submitting');
    assert.equal(intent.idempotencyKey,init.headers['idempotency-key']);
    assert.equal(url,`${ORIGIN}/v1/video/generations`);
    assert.equal(init.redirect,'manual');
    assert.equal(init.headers.authorization,`Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(init.body),{model:MODEL,prompt:'Move the clouds',duration_seconds:5,resolution:'720p',image_url:'https://images.example.com/source.png',provider:'api.venice.ai',providers_blocked:['antseed']});
    return accepted();
  });
  const response=await context.bridge.queue(body(),quote());
  assert.equal(response.status,200);
  const value=await response.json();
  assert.match(value.queue_id,/^video_[a-f0-9]{32}$/);
  assert.deepEqual(value,{queue_id:value.queue_id,status:'QUEUED'});
  assert.equal(calls,1);
  const saved=JSON.parse(await readFile(join(context.stateDir,'video-bridge','journal.json'),'utf8'));
  assert.equal(saved.jobs[value.queue_id].siId,SI_ID);
  assert.equal(saved.jobs[value.queue_id].jobToken,TOKEN);
  assert.equal(saved.jobs[value.queue_id].service,MODEL);
  assert.equal(saved.jobs[value.queue_id].durationSeconds,5);
  assert.equal((await stat(join(context.stateDir,'video-bridge'))).mode&0o777,0o700);
  assert.equal((await stat(join(context.stateDir,'video-bridge','journal.json'))).mode&0o777,0o600);
  assert.ok(!JSON.stringify(value).includes(TOKEN));
});

test('server enforces reviewed model, host, expiry and all fixed video inputs before spending',async t=>{
  let calls=0;
  const {bridge}=await fixture(t,async()=>{calls++;return accepted();});
  const invalidBodies=[{duration:10},{duration:'auto'},{duration:undefined},{duration_seconds:10},{resolution:'1080p'},{audio:false},{aspect_ratio:'16:9'},{provider:'evil.example'},{webhook_url:'https://evil.example'},{image_url:undefined},{image_url:'http://example.com/x.png'},{image_url:'https://127.0.0.1/x.png'},{prompt:''},{prompt:'x'.repeat(2001)},{_requestId:undefined},{end_image_url:'https://example.com/end.png'}];
  for(const change of invalidBodies) assert.equal((await bridge.queue({...body(),...change},quote())).status,400,JSON.stringify(change));
  for(const change of [{kind:'text'},{provider:'openrouter.ai'},{upstreamModel:'unknown-video'},{policyExpiresAt:new Date(clock).toISOString()},{policyExpiresAt:undefined},{media:{parameters:{duration_seconds:10,resolution:'720p'}}},{media:{parameters:{duration_seconds:5,resolution:'720p',audio:false}}}]) assert.equal((await bridge.queue(body(),{...quote(),...change})).status,503,JSON.stringify(change));
  assert.equal(calls,0);
});

test('a stable trusted request id deduplicates across restart and rejects changed intent',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const first=await (await context.bridge.queue(body(),quote())).json();
  const replay=await (await context.restart().queue(body(),quote())).json();
  assert.deepEqual(replay,first);
  assert.equal((await context.restart().queue({...body(),prompt:'Changed'},quote())).status,409);
  const withoutBodyId=body();delete withoutBodyId._requestId;
  assert.equal((await context.restart().queue(withoutBodyId,quote(),{requestId:'request-1'})).status,200);
  assert.equal(calls,1);
});

test('ambiguous POST is durably uncertain and is never automatically submitted again',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;throw new Error(`network lost ${TOKEN} ${KEY}`);});
  const first=await context.bridge.queue(body(),quote());
  assert.equal(first.status,503);
  assert.equal((await first.json()).error.code,'submission_uncertain');
  assert.equal((await context.restart().queue(body(),quote())).status,503);
  const saved=JSON.parse(await readFile(join(context.stateDir,'video-bridge','journal.json'),'utf8'));
  assert.equal(Object.values(saved.jobs)[0].state,'uncertain');
  assert.equal(calls,1);
  assert.ok(!JSON.stringify(context.events).includes(TOKEN));
});

for(const outcome of ['accepted','uncertain'])test(`${outcome} request cannot reset deduplication after entire component-directory loss`,async t=>{
  let posts=0;
  const context=await fixture(t,async(url,init)=>{
    assert.equal(init.method,'POST');posts++;
    if(outcome==='uncertain' && posts===1)throw new Error('response lost after submission');
    return accepted();
  });
  const first=await context.bridge.queue(body(),quote());
  assert.equal(first.status,outcome==='accepted'?200:503);
  const firstValue=await first.json();
  const normalReplay=await context.restart().queue(body(),quote());
  assert.equal(normalReplay.status,outcome==='accepted'?200:503);
  if(outcome==='accepted')assert.deepEqual(await normalReplay.json(),firstValue);
  assert.equal(posts,1);
  await rm(join(context.stateDir,'video-bridge'),{recursive:true});
  assert.equal((await stat(context.stateDir)).isDirectory(),true,'the enclosing private root is retained');
  const replay=await context.restart().queue(body(),quote()),replayValue=await replay.json();
  t.diagnostic(JSON.stringify({outcome,firstStatus:first.status,replayStatus:replay.status,posts,firstQueueId:firstValue.queue_id,replayQueueId:replayValue.queue_id}));
  assert.deepEqual({status:replay.status,posts},{status:503,posts:1},'lost component state must fail closed rather than issue a second POST');
  await assert.rejects(stat(join(context.stateDir,'video-bridge')),{code:'ENOENT'},'do not silently recreate lost component state');
});

test('missing, corrupt, public or symlinked initialization markers fail closed with existing component state',async t=>{
  for(const mutation of [
    async path=>rm(path),
    async path=>writeFile(path,'invalid marker'),
    async path=>chmod(path,0o644),
    async path=>{const target=path+'-target';await writeFile(target,MARKER_BYTES,{mode:0o600});await rm(path);await symlink(target,path);},
  ]){
    let calls=0;
    const context=await fixture(t,async()=>{calls++;return accepted();});
    await queueId(context);
    const path=join(context.stateDir,MARKER);
    // Seed only for the unfixed implementation, independently testing checks.
    await writeFile(path,MARKER_BYTES,{mode:0o600});
    await mutation(path);
    const journalPath=join(context.stateDir,'video-bridge','journal.json'),before=await readFile(journalPath);
    assert.equal((await context.restart().queue(body('new-request'),quote())).status,503);
    assert.equal(calls,1);
    assert.deepEqual(await readFile(journalPath),before,'invalid marker must not rewrite accepted state');
  }
});

test('existing component directory without an initialization marker cannot bootstrap over an empty journal',async t=>{
  let calls=0;const context=await fixture(t,async()=>{calls++;return accepted();});
  const dir=join(context.stateDir,'video-bridge');await mkdir(dir,{mode:0o700});
  await writeFile(join(dir,'journal.json'),JSON.stringify({version:1,jobs:{}}),{mode:0o600});
  assert.equal((await context.bridge.queue(body(),quote())).status,503);
  assert.equal(calls,0);
  await assert.rejects(stat(join(context.stateDir,MARKER)),{code:'ENOENT'},'never manufacture missing initialization provenance');
});

test('crash-window submitting intent is not replayed even with the original request id',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  await context.bridge.queue(body(),quote());
  const path=join(context.stateDir,'video-bridge','journal.json'),saved=JSON.parse(await readFile(path,'utf8'));
  Object.values(saved.jobs)[0].state='submitting';
  await writeFile(path,JSON.stringify(saved));
  assert.equal((await context.restart().queue(body(),quote())).status,503);
  assert.equal(calls,1);
});

test('persistent process lock and corrupted journals fail closed without any submission',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const dir=join(context.stateDir,'video-bridge');await mkdir(dir,{mode:0o700});
  await mkdir(join(dir,'lock'));
  assert.equal((await context.bridge.queue(body(),quote())).status,503);
  await rm(join(dir,'lock'),{recursive:true});
  await writeFile(join(dir,'journal.json'),'not json',{mode:0o600});
  assert.equal((await context.restart().queue(body(),quote())).status,503);
  assert.equal(calls,0);
});

test('symlinked private state is never read or overwritten',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const outside=join(context.stateDir,'outside');await mkdir(outside);
  await symlink(outside,join(context.stateDir,'video-bridge'));
  assert.equal((await context.bridge.queue(body(),quote())).status,503);
  assert.equal(calls,0);
});

// Minimal MP4 container fixture: ftyp + moov/mvhd, not a generated playable clip.
function mp4(seconds=5){
  const box=(type,data)=>{const bytes=Buffer.alloc(8+data.length);bytes.writeUInt32BE(bytes.length);bytes.write(type,4);data.copy(bytes,8);return bytes;};
  const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(seconds*1000,16);
  return Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov',box('mvhd',mvhd))]);
}
const pollValue=(status,extra={})=>({id:SI_ID,status,...extra});
const success=()=>pollValue('succeeded',{results:[{artifact_index:0,url:'https://evil.example/leak',content_type:'video/mp4',bytes:mp4().length,duration_seconds:5}],usage:{buyer_cost_usdc:'15432',seller_cost_usdc:'14400',settlement_status:'settled'}});
async function queueId(context){const response=await context.bridge.queue(body(),quote());assert.equal(response.status,200);return (await response.json()).queue_id;}

test('retrieve rejects malformed, unknown and wrong-service jobs without contacting SI',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const id=await queueId(context);
  for(const [job,service] of [['../journal',MODEL],[SI_ID,MODEL],['video_'+'0'.repeat(32),MODEL],[id,'other-model'],[id,undefined]]){
    assert.equal((await context.bridge.retrieve(job,service)).status,404);
  }
  assert.equal(calls,1);
});

test('polls only the canonical SI path with scoped job token and translates in-progress native states',async t=>{
  const states=['queued','submitted','running'];const calls=[];
  const context=await fixture(t,async(url,init)=>{
    calls.push([url,init]);
    if(init.method==='POST')return accepted();
    return Response.json(pollValue(states.shift()));
  });
  const id=await queueId(context);
  for(const status of ['QUEUED','PROCESSING','PROCESSING']){
    const response=await context.restart().retrieve(id,MODEL);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{queue_id:id,status});
  }
  for(const [url,init] of calls.slice(1)){
    assert.equal(url,`${ORIGIN}/v1/video/generations/${SI_ID}`);
    assert.deepEqual(init.headers,{'x-job-token':TOKEN});
    assert.equal(init.redirect,'manual');
  }
});

test('terminal failures are persisted and emit only sanitized actual-cost lifecycle metadata',async t=>{
  for(const status of ['failed','canceled','expired']){
    let calls=0;
    const context=await fixture(t,async(url,init)=>{
      calls++;return init.method==='POST'?accepted():Response.json(pollValue(status,{error:{message:`secret ${TOKEN}`},usage:{buyer_cost_usdc:'123',settlement_status:'settled'}}));
    });
    const id=await queueId(context);
    const response=await context.bridge.retrieve(id,MODEL);
    assert.deepEqual(await response.json(),{queue_id:id,status:status.toUpperCase()});
    assert.deepEqual(await (await context.restart().retrieve(id,MODEL)).json(),{queue_id:id,status:status.toUpperCase()});
    assert.equal(calls,2);
    assert.deepEqual(context.events,[{queueId:id,service:MODEL,provider:'api.venice.ai',siJobId:SI_ID,status,actualCostMicro:'123',settlementStatus:'settled'}]);
  }
});

test('success retrieves real artifact bytes from canonical SI endpoint and caches privately across restart',async t=>{
  const calls=[];
  const context=await fixture(t,async(url,init)=>{
    calls.push([url,init]);
    if(init.method==='POST')return accepted();
    if(url.includes('/video/generations/'))return Response.json(success());
    assert.equal(url,`${ORIGIN}/v1/media/artifacts/${SI_ID}/0`);
    assert.deepEqual(init.headers,{'x-job-token':TOKEN});
    return new Response(mp4(),{headers:{'content-type':'video/mp4','content-length':String(mp4().length)}});
  });
  const id=await queueId(context);
  for(const bridge of [context.bridge,context.restart()]){
    const response=await bridge.retrieve(id,MODEL);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'video/mp4');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp4());
  }
  assert.equal(calls.length,3);
  const cached=join(context.stateDir,'video-bridge',`${id}.mp4`);
  assert.deepEqual(await readFile(cached),mp4());
  assert.equal((await stat(cached)).mode&0o777,0o600);
  assert.equal(context.events.length,1);
  assert.equal(context.events[0].actualCostMicro,'15432');
  assert.ok(!JSON.stringify(context.events).includes(TOKEN));
});

test('unknown SI states, identity mismatch and malformed poll bodies cannot become delivery',async t=>{
  for(const value of [pollValue('mystery'),{id:'different',status:'succeeded',results:[]},{...success(),results:[{artifact_index:'../secret'}]},null]){
    const context=await fixture(t,async(url,init)=>init.method==='POST'?accepted():Response.json(value));
    const id=await queueId(context);
    const response=await context.bridge.retrieve(id,MODEL);
    assert.equal(response.status,502);
    assert.notEqual(response.headers.get('content-type'),'video/mp4');
  }
});

test('302 artifact downloads strip credentials off origin and pin only allowlisted public DNS addresses',async t=>{
  const external='https://media.venice.ai/render.mp4?signature=private';const lookups=[];
  const context=await fixture(t,async(url,init)=>{
    if(init.method==='POST')return accepted();
    if(url.includes('/video/generations/'))return Response.json(success());
    if(url.startsWith(ORIGIN))return new Response(null,{status:302,headers:{location:external}});
    assert.equal(url,external);assert.deepEqual(init.headers,{});
    assert.equal(init.redirect,'manual');assert.ok(init.dispatcher,'DNS-pinned dispatcher is required');
    return new Response(mp4(),{headers:{'content-type':'video/mp4'}});
  },{artifactHosts:['media.venice.ai'],lookup:async host=>{lookups.push(host);return [{address:'93.184.216.34',family:4}];}});
  const id=await queueId(context),response=await context.bridge.retrieve(id,MODEL);
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp4());
  assert.deepEqual(lookups,['media.venice.ai']);
  assert.ok(!JSON.stringify(context.events).includes('signature'));
});

test('unapproved, private, credentialed and downgraded redirects are denied before download',async t=>{
  const locations=['https://evil.example/leak','http://media.venice.ai/x','https://user:pass@media.venice.ai/x','https://media.venice.ai:8443/x','https://127.0.0.1/x','https://[::1]/x','https://2130706433/x','https://media.venice.ai.evil.example/x','https://api.surplusintelligence.ai/v1/secret'];
  for(const location of locations){
    let calls=0;
    const context=await fixture(t,async(url,init)=>{calls++;if(init.method==='POST')return accepted();if(url.includes('/video/generations/'))return Response.json(success());return new Response(null,{status:302,headers:{location}});},{artifactHosts:['media.venice.ai'],lookup:async()=>[{address:'93.184.216.34',family:4}]});
    const id=await queueId(context);assert.equal((await context.bridge.retrieve(id,MODEL)).status,502,location);assert.equal(calls,3,location);
  }
});

test('allowlisted DNS pointing at private or mixed address sets is rejected and redirect loops are bounded',async t=>{
  for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'10.1.2.3',family:4}],[{address:'::ffff:127.0.0.1',family:6}],[{address:'93.184.216.34',family:4},{address:'169.254.169.254',family:4}]]){
    let downloads=0;
    const context=await fixture(t,async(url,init)=>{if(init.method==='POST')return accepted();if(url.includes('/video/generations/'))return Response.json(success());if(!url.startsWith(ORIGIN))downloads++;return new Response(null,{status:302,headers:{location:'https://media.venice.ai/x'}});},{artifactHosts:['media.venice.ai'],lookup:async()=>addresses});
    const id=await queueId(context);assert.equal((await context.bridge.retrieve(id,MODEL)).status,502);assert.equal(downloads,0);
  }
  let calls=0;
  const context=await fixture(t,async(url,init)=>{calls++;if(init.method==='POST')return accepted();if(url.includes('/video/generations/'))return Response.json(success());return new Response(null,{status:302,headers:{location:'https://media.venice.ai/loop'}});},{artifactHosts:['media.venice.ai'],lookup:async()=>[{address:'93.184.216.34',family:4}],maxRedirects:2});
  const id=await queueId(context);assert.equal((await context.bridge.retrieve(id,MODEL)).status,502);assert.equal(calls,5);
});

test('artifact MIME, encoding, declared length, MP4 duration and container are validated before delivery',async t=>{
  const badArtifacts=[
    ()=>Response.json({url:'https://media.venice.ai/file'}),
    ()=>new Response(mp4(),{headers:{'content-type':'text/html'}}),
    ()=>new Response(mp4(),{headers:{'content-type':'video/mp4','content-encoding':'gzip'}}),
    ()=>new Response(mp4(),{headers:{'content-type':'video/mp4','content-length':'67108865'}}),
    ()=>new Response(mp4(),{headers:{'content-type':'video/mp4','content-length':'1'}}),
    ()=>new Response(mp4(),{headers:{'content-type':'video/mp4','content-length':String(mp4().length+1)}}),
    ()=>new Response(mp4(1),{headers:{'content-type':'video/mp4'}}),
    ()=>new Response('not an mp4',{headers:{'content-type':'video/mp4'}}),
    ()=>new Response(null,{status:204}),
  ];
  for(const make of badArtifacts){
    const context=await fixture(t,async(url,init)=>init.method==='POST'?accepted():url.includes('/video/generations/')?Response.json(success()):make());
    const id=await queueId(context),response=await context.bridge.retrieve(id,MODEL);
    assert.equal(response.status,502);assert.notEqual(response.headers.get('content-type'),'video/mp4');
  }
});

test('chunked downloads stop at configured byte cap and never expose partial MP4 bytes',async t=>{
  let canceled=false;
  const context=await fixture(t,async(url,init)=>{
    if(init.method==='POST')return accepted();if(url.includes('/video/generations/'))return Response.json(success());
    let chunks=0;
    return new Response(new ReadableStream({pull(controller){if(chunks++===3)controller.close();else controller.enqueue(new Uint8Array(160));},cancel(){canceled=true;}}),{headers:{'content-type':'video/mp4'}});
  },{maxArtifactBytes:256});
  const id=await queueId(context),response=await context.bridge.retrieve(id,MODEL);
  assert.equal(response.status,502);assert.equal(canceled,true);
});

test('network calls and stalled body reads have finite deadlines including injected transports',{timeout:1000},async t=>{
  const pending=()=>new Promise(()=>{});
  const context=await fixture(t,pending,{requestTimeoutMs:20});
  assert.equal((await context.bridge.queue(body(),quote())).status,503);
  let canceled=false;
  const second=await fixture(t,async(url,init)=>{
    if(init.method==='POST')return accepted();if(url.includes('/video/generations/'))return Response.json(success());
    return new Response(new ReadableStream({start(){},cancel(){canceled=true;}}),{headers:{'content-type':'video/mp4'}});
  },{downloadTimeoutMs:20});
  const id=await queueId(second);assert.equal((await second.bridge.retrieve(id,MODEL)).status,502);assert.equal(canceled,true);
});

test('cached bytes are integrity checked on restart and are not regenerated when corrupted',async t=>{
  let calls=0;
  const context=await fixture(t,async(url,init)=>{calls++;return init.method==='POST'?accepted():url.includes('/video/generations/')?Response.json(success()):new Response(mp4(),{headers:{'content-type':'video/mp4'}});});
  const id=await queueId(context);assert.equal((await context.bridge.retrieve(id,MODEL)).status,200);
  await writeFile(join(context.stateDir,'video-bridge',`${id}.mp4`),'corrupted');
  assert.equal((await context.restart().retrieve(id,MODEL)).status,503);assert.equal(calls,3);
});

test('constructor refuses untrusted origins, malformed credentials and unbounded media limits',async t=>{
  const context=await fixture(t,async()=>accepted());
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  for(const settings of [
    {...context.options.settings,surplusBaseUrl:'https://evil.example/v1'},
    {...context.options.settings,surplusBaseUrl:ORIGIN+'/v1?secret=1'},
    ...[{maxArtifactBytes:67108865},{maxArtifactBytes:0},{requestTimeoutMs:0},{requestTimeoutMs:Infinity},{downloadTimeoutMs:300001},{maxRedirects:6}].map(videoBridgeConfig=>({...context.options.settings,videoBridgeConfig})),
    ...[['*.venice.ai'],['127.0.0.1'],['media.venice.ai.evil.local'],['https://media.venice.ai']].map(mediaArtifactHosts=>({...context.options.settings,mediaArtifactHosts})),
  ])assert.throws(()=>createVideoBridge({...context.options,settings}));
  for(const apiKey of ['',undefined,'x\r\ny'])assert.throws(()=>createVideoBridge({...context.options,apiKey}));
});

test('invalid acceptance responses preserve uncertainty and never permit another paid submit',async t=>{
  for(const response of [
    ()=>Response.json({status:'queued',job_token:TOKEN},{status:202}),
    ()=>Response.json({id:null,status:'queued',job_token:TOKEN},{status:202}),
    ()=>Response.json({id:'../secret',status:'queued',job_token:TOKEN},{status:202}),
    ()=>Response.json({id:SI_ID,status:'queued',job_token:TOKEN+'\n'},{status:202}),
    ()=>Response.json({id:SI_ID,status:'not-real',job_token:TOKEN},{status:202}),
    ()=>new Response(null,{status:302,headers:{location:'https://evil.example'}}),
    ()=>Response.json({error:{message:TOKEN}},{status:500}),
    ()=>new Response('{bad json',{status:202,headers:{'content-type':'application/json'}}),
    ()=>new Response('x'.repeat(1024*1024+1),{status:202,headers:{'content-type':'application/json'}}),
  ]){
    let calls=0;
    const context=await fixture(t,async()=>{calls++;return response();});
    const first=await context.bridge.queue(body(),quote());assert.equal(first.status,503);
    assert.ok(!(await first.text()).includes(TOKEN));
    assert.equal((await context.restart().queue(body(),quote())).status,503);assert.equal(calls,1);
  }
});

test('concurrent bridge instances cannot duplicate one paid submission',async t=>{
  let calls=0,started,finish;
  const start=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const context=await fixture(t,async()=>{calls++;started();await gate;return accepted();});
  const pending=context.bridge.queue(body(),quote());await start;
  assert.equal((await context.restart().queue(body(),quote())).status,503);
  finish();assert.equal((await pending).status,200);
  assert.equal((await context.restart().queue(body(),quote())).status,200);assert.equal(calls,1);
});

test('deleted or structurally invalid journal cannot reset deduplication after restart',async t=>{
  for(const mutation of [async path=>rm(path),async path=>writeFile(path,JSON.stringify({version:1,jobs:[]})),async path=>{const saved=JSON.parse(await readFile(path,'utf8'));Object.values(saved.jobs)[0].siId='../secret';await writeFile(path,JSON.stringify(saved));}]){
    let calls=0;const context=await fixture(t,async()=>{calls++;return accepted();});
    await queueId(context);await mutation(join(context.stateDir,'video-bridge','journal.json'));
    assert.equal((await context.restart().queue(body(),quote())).status,503);assert.equal(calls,1);
  }
});

test('consent is checked again immediately before the paid send after persistence awaits',async t=>{
  let checks=0,calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  const bridge=createVideoBridge({...context.options,now:()=>++checks===1?clock:clock+120000});
  assert.equal((await bridge.queue(body(),quote())).status,503);assert.equal(calls,0);
});

test('artifact retries never regenerate and a late settlement updates actual-cost metadata while serving cached bytes',async t=>{
  let posts=0,polls=0,downloads=0;
  const context=await fixture(t,async(url,init)=>{
    if(init.method==='POST'){posts++;return accepted();}
    if(url.includes('/video/generations/')){polls++;const value=success();if(polls===1)value.usage={settlement_status:'pending'};return Response.json(value);}
    downloads++;return new Response(mp4(),{headers:{'content-type':'video/mp4'}});
  });
  const id=await queueId(context);
  assert.equal((await context.bridge.retrieve(id,MODEL)).status,200);
  assert.equal((await context.restart().retrieve(id,MODEL)).status,200);
  assert.equal(context.events.at(-1).actualCostMicro,'15432');
  assert.equal(context.events.at(-1).settlementStatus,'settled');
  assert.equal(posts,1);assert.equal(polls,2);assert.equal(downloads,1);
});

test('capacity is reserved for acceptance credentials and terminal metadata before any paid send',async t=>{
  let calls=0;const context=await fixture(t,async()=>{calls++;return accepted();});
  const id=await queueId(context),path=join(context.stateDir,'video-bridge','journal.json');
  const saved=JSON.parse(await readFile(path,'utf8')),next=structuredClone(saved.jobs[id]);
  delete next.siId;delete next.jobToken;next.state='submitting';
  // All variable-length identifiers have the same serialized length as this job.
  const future={...saved,jobs:{...saved.jobs,['video_'+'f'.repeat(32)]:next},padding:''};
  saved.padding='p'.repeat(16*1024*1024-Buffer.byteLength(JSON.stringify(future))-16);
  await writeFile(path,JSON.stringify(saved));
  const response=await context.restart().queue(body('request-2'),quote());
  assert.equal(response.status,503);assert.equal(calls,1,'insufficient lifecycle-journal capacity must refuse before POST');
});

test('concurrent first-use initialization cannot strand an empty state directory',{timeout:3000},async t=>{
  let calls=0;const context=await fixture(t,async()=>{calls++;return accepted();});
  const target=join(context.stateDir,'video-bridge'),original=fs.mkdir;
  let releaseCreator,releaseWinner,created,acquired,firstDirectory=true;
  const creatorGate=new Promise(resolve=>{releaseCreator=resolve;}),winnerGate=new Promise(resolve=>{releaseWinner=resolve;});
  const directoryCreated=new Promise(resolve=>{created=resolve;}),winnerLocked=new Promise(resolve=>{acquired=resolve;});
  fs.mkdir=async(path,options)=>{
    const result=await original(path,options);
    if(path===target && firstDirectory){firstDirectory=false;created();await creatorGate;}
    else if(path===join(target,'lock')){acquired();await winnerGate;}
    return result;
  };
  syncBuiltinESMExports();
  try {
    const first=context.bridge.queue(body(),quote());await directoryCreated;
    const second=context.restart().queue(body(),quote());
    const result=await Promise.race([winnerLocked.then(()=> 'lock-winner'),second.then(()=> 'refused')]);
    releaseCreator();
    if(result==='lock-winner')await first;
    releaseWinner();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.status,200,'the initializer must retain exclusive bootstrap ownership');
    assert.equal(b.status,503);
    assert.equal((await context.restart().queue(body(),quote())).status,200);assert.equal(calls,1);
  }finally{releaseCreator();releaseWinner();fs.mkdir=original;syncBuiltinESMExports();}
});

test('state directory entry is fsynced in its parent before submission',async t=>{
  let rootSynced=false;
  const context=await fixture(t,async()=>{assert.equal(rootSynced,true,'durable files need a durable parent directory entry');return accepted();});
  const original=fs.open;
  fs.open=async(path,...args)=>{
    const handle=await original(path,...args);
    if(path===context.stateDir){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();rootSynced=true;};}
    return handle;
  };
  syncBuiltinESMExports();
  try{assert.equal((await context.bridge.queue(body(),quote())).status,200);assert.equal(rootSynced,true);}finally{fs.open=original;syncBuiltinESMExports();}
});

// Observe completed real fsyncs; these tests do not simulate a power loss.
function observeSyncs(events,failPath){
  const original=fs.open;
  fs.open=async(path,...args)=>{
    const handle=await original(path,...args),sync=handle.sync.bind(handle);
    handle.sync=async()=>{
      if(path===failPath){events.push(['sync-failed',path]);throw Object.assign(new Error('directory fsync unavailable'),{code:'ENOTSUP'});}
      await sync();events.push(['sync',path]);
    };
    return handle;
  };
  syncBuiltinESMExports();
  return ()=>{fs.open=original;syncBuiltinESMExports();};
}
function parentChain(path){
  const parents=[];
  for(let parent=dirname(path);;parent=dirname(parent)){
    parents.push(parent);if(parent===dirname(parent))return parents;
  }
}

test('private initialization marker and its root entry are fsynced before POST',async t=>{
  const events=[];let calls=0;
  const context=await fixture(t,async()=>{
    calls++;events.push(['post']);
    const path=join(context.stateDir,MARKER);
    assert.equal(await readFile(path,'utf8'),MARKER_BYTES);
    assert.equal((await stat(path)).mode&0o777,0o600);
    return accepted();
  });
  const restore=observeSyncs(events);
  try{
    assert.equal((await context.bridge.queue(body(),quote())).status,200);
    const marker=events.findIndex(([kind,path])=>kind==='sync' && path===join(context.stateDir,MARKER));
    const root=events.findIndex(([kind,path],index)=>index>marker && kind==='sync' && path===context.stateDir);
    const post=events.findIndex(([kind])=>kind==='post');
    assert.ok(marker>=0 && root>marker && post>root,'marker file fsync then root directory fsync must precede POST');
    assert.equal(calls,1);
  }finally{restore();}
});

for(const failMarker of [true,false])test(`interrupted initialization at ${failMarker?'marker file':'marker root'} fsync cannot rebootstrap`,async t=>{
  let calls=0;const events=[];
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const path=failMarker?join(context.stateDir,MARKER):context.stateDir;
  const restore=observeSyncs(events,path);
  try{
    assert.equal((await context.bridge.queue(body(),quote())).status,503);
    assert.ok(events.some(([kind,target])=>kind==='sync-failed' && target===path));
    assert.equal(calls,0);
  }finally{restore();}
  assert.equal(await readFile(join(context.stateDir,MARKER),'utf8'),MARKER_BYTES);
  await assert.rejects(stat(join(context.stateDir,'video-bridge')),{code:'ENOENT'});
  assert.equal((await context.restart().queue(body(),quote())).status,503,'partial initialization must require manual recovery, not a fresh empty journal');
  assert.equal(calls,0);
});

for(const precreated of [false,true])test(`journal root ancestry is fsynced before POST when ${precreated?'created by the caller without a durability barrier':'new and deeply nested'}`,async t=>{
  const events=[];let calls=0,intentAtSend;
  const context=await fixture(t,async(url,init)=>{
    calls++;events.push(['post',url]);
    intentAtSend=JSON.parse(await readFile(join(stateDir,'video-bridge','journal.json'),'utf8'));
    return accepted();
  });
  const stateDir=join(context.stateDir,'new-parent','new-child','private-state');
  if(precreated)await mkdir(stateDir,{recursive:true,mode:0o700});
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  const restart=()=>createVideoBridge({...context.options,settings:{...context.options.settings,stateDir}});
  const restore=observeSyncs(events);
  try {
    const first=await restart().queue(body(),quote());
    assert.equal(first.status,200);
    const post=events.findIndex(([kind])=>kind==='post');
    let previous=-1;
    for(const parent of parentChain(stateDir)){
      const synced=events.findIndex(([kind,path])=>kind==='sync' && path===parent);
      assert.ok(synced>previous && synced<post,`must fsync ancestor ${parent} bottom-up before POST`);
      previous=synced;
    }
    assert.equal(Object.values(intentAtSend.jobs).length,1);
    const [job]=Object.values(intentAtSend.jobs);
    assert.equal(job.state,'submitting');
    assert.equal(job.payload.prompt,body().prompt);
    const journalSynced=events.findIndex(([kind,path])=>kind==='sync' && path===join(stateDir,'video-bridge'));
    assert.ok(journalSynced>=0 && journalSynced<post,'journal publication must be fsynced before POST');
    assert.deepEqual(await (await restart().queue(body(),quote())).json(),await first.json());
    assert.equal(calls,1,'restart must retain the one accepted mapping without a new POST');
    const saved=JSON.parse(await readFile(join(stateDir,'video-bridge','journal.json'),'utf8'));
    assert.equal(Object.values(saved.jobs).length,1);
    assert.equal(Object.values(saved.jobs)[0].state,'accepted');
  }finally{restore();}
});

test('symlinked root ancestry fails closed rather than skipping physical parent durability',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const target=join(context.stateDir,'target-parent','target-child');
  await mkdir(target,{recursive:true,mode:0o700});
  const alias=join(context.stateDir,'alias');await symlink(target,alias);
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  const stateDir=join(alias,'private-state');
  const restart=()=>createVideoBridge({...context.options,settings:{...context.options.settings,stateDir}});
  for(let attempt=0;attempt<2;attempt++){
    assert.equal((await restart().queue(body(),quote())).status,503,'an alias must not hide unsynced physical ancestors');
    assert.equal(calls,0);
  }
  await assert.rejects(stat(join(target,'private-state','video-bridge')),{code:'ENOENT'},'refuse before journal bootstrap');
});

test('unsupported ancestor fsync fails closed before transport even for a caller-created root',async t=>{
  let calls=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  const stateDir=join(context.stateDir,'caller-parent','caller-child','private-state');
  await mkdir(stateDir,{recursive:true,mode:0o700});
  const restart=()=>createVideoBridge({...context.options,settings:{...context.options.settings,stateDir}});
  for(const failPath of parentChain(stateDir)){
    const events=[],restore=observeSyncs(events,failPath);
    try {
      for(let attempt=0;attempt<2;attempt++){
        const response=await restart().queue(body(),quote());
        assert.equal(response.status,503,`unsupported fsync for ${failPath} must refuse`);
        assert.equal((await response.json()).error.code,'video_bridge_unavailable');
      }
      assert.equal(events.filter(([kind,path])=>kind==='sync-failed' && path===failPath).length,2);
      assert.equal(calls,0,'failed ancestry barrier must not invoke paid transport');
    }finally{restore();}
  }
  assert.equal((await restart().queue(body(),quote())).status,200,'a failed pre-submit barrier must remain recoverable');
  assert.equal((await restart().queue(body(),quote())).status,200);
  assert.equal(calls,1);
});

test('marker removal during final consent check prevents the actual paid invocation',async t=>{
  let calls=0,checks=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  await queueId(context);calls=0;
  await writeFile(join(context.stateDir,MARKER),MARKER_BYTES,{mode:0o600});
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  const bridge=createVideoBridge({...context.options,now:()=>{
    if(++checks===3)unlinkSync(join(context.stateDir,MARKER));
    return clock;
  }});
  assert.equal((await bridge.queue(body('new-request'),quote())).status,503);assert.equal(calls,0);
});

test('journal removal during final consent check prevents the actual paid invocation',async t=>{
  let calls=0,checks=0;
  const context=await fixture(t,async()=>{calls++;return accepted();});
  const {createVideoBridge}=await import('../lib/video-bridge.mjs');
  const bridge=createVideoBridge({...context.options,now:()=>{
    if(++checks===3)unlinkSync(join(context.stateDir,'video-bridge','journal.json'));
    return clock;
  }});
  assert.equal((await bridge.queue(body(),quote())).status,503);assert.equal(calls,0);
});
