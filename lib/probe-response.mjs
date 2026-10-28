export function inspectProbeResponse(text,stream=false){
 if(!stream){const data=JSON.parse(text);if(data.error)throw Error('Paid inference failed');return {content:data.choices?.[0]?.message?.content,usage:data.usage};}
 let content='',usage,done=false;
 for(const line of text.split(/\r?\n/)){
  if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(!raw)continue;if(raw==='[DONE]'){done=true;continue;}
  const data=JSON.parse(raw);if(data.error)throw Error('Paid stream failed');
  for(const choice of data.choices??[])if(typeof choice.delta?.content==='string')content+=choice.delta.content;
  if(data.usage)usage=data.usage;
 }
 if(!done)throw Error('Paid stream incomplete');return {content,usage};
}
