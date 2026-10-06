import type { Segment } from "../types/speaker.ts";

export function applySpeakerNames(segments:Segment[],speakers:string[],embeddings:Record<string,number[]>,names:Record<string,string>) {
  return {segments:segments.map(s=>names[s.speaker]?{...s,speaker:names[s.speaker],auto:false}:s),speakers:[...new Set(speakers.map(s=>names[s]||s))],embeddings:Object.fromEntries(Object.entries(embeddings).map(([s,e])=>[names[s]||s,e]))};
}

/** Transfer names only with channel/timing evidence, never diarization index alone. */
export function reconcileSpeakerNames(previous:Segment[],final:Segment[],names:Record<string,string>) {
  const resolved:Record<string,string>={};const conflicts=new Set<string>();
  const assign=(speaker:string,name:string)=>{if(conflicts.has(speaker))return;if(resolved[speaker]&&resolved[speaker]!==name){delete resolved[speaker];conflicts.add(speaker);}else resolved[speaker]=name;};
  for(const [original,name]of Object.entries(names)) {
    const source=previous.filter(s=>s.speaker===original);if(!source.length)continue;
    const mic=source.every(s=>s.channel==="mic");const candidates=[...new Set(final.filter(s=>mic?s.channel==="mic":s.channel!=="mic").map(s=>s.speaker))];
    if(mic&&candidates.length===1){assign(candidates[0],name);continue;}
    const scores=candidates.map(speaker=>({speaker,overlap:final.filter(s=>s.speaker===speaker).reduce((sum,target)=>sum+source.reduce((n,origin)=>n+(origin.end>origin.start&&target.end>target.start?Math.max(0,Math.min(origin.end,target.end)-Math.max(origin.start,target.start)):0),0),0)})).sort((a,b)=>b.overlap-a.overlap);
    const total=scores.reduce((sum,s)=>sum+s.overlap,0);
    if(scores[0]?.overlap>=0.25&&scores[0].overlap>=total*0.7&&(!scores[1]||scores[0].overlap>scores[1].overlap*2))assign(scores[0].speaker,name);
  }
  return resolved;
}
