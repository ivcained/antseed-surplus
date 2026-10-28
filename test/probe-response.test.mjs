import test from 'node:test';
import assert from 'node:assert/strict';
test('probe understands actual SSE text deltas, final usage and DONE',async()=>{
 const {inspectProbeResponse}=await import('../lib/probe-response.mjs');
 const text=['data: '+JSON.stringify({choices:[{delta:{content:'antseed surplus '}}]}),'data: '+JSON.stringify({choices:[{delta:{content:'resale works'}}]}),'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:5,buyer_cost_micro:1}}),'data: [DONE]'].join('\n\n')+'\n\n';
 assert.deepEqual(inspectProbeResponse(text,true),{content:'antseed surplus resale works',usage:{prompt_tokens:100,completion_tokens:5,buyer_cost_micro:1}});
 assert.throws(()=>inspectProbeResponse(text.replace('data: [DONE]',''),true),/incomplete/);
 assert.throws(()=>inspectProbeResponse('data: '+JSON.stringify({error:{message:'no'}})+'\n\ndata: [DONE]\n\n',true),/stream failed/);
});
