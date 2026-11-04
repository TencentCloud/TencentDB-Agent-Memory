import {hash} from './adapters.mjs';
// New ingestion adapter, not a retroactive change to any frozen experiment.
// Store alignment only in the evaluator. Runtime source identifiers carry no
// answer-session prefixes, turn offsets or dataset labels.
export function opaqueSourceIds(subject){
 if(!subject||typeof subject.subject_id!=='string'||!Array.isArray(subject.messages)||subject.messages.length>100000||!Array.isArray(subject.probes))throw Error('source_schema');
 const turns=new Map(),sessions=new Map(),originalSessions=new Map(),sid=subject.subject_id;
 for(const m of subject.messages){if(typeof m.id!=='string'||typeof m.session_id!=='string'||typeof m.content!=='string'||turns.has(m.id))throw Error('message_schema');
  turns.set(m.id,'turn_'+hash('opaque-source-v1\0'+sid+'\0'+m.id).slice(0,24));if(!sessions.has(m.session_id))sessions.set(m.session_id,'session_'+hash('opaque-session-v1\0'+sid+'\0'+m.session_id).slice(0,24));
  if(m.original_session_id){if(!originalSessions.has(m.original_session_id))originalSessions.set(m.original_session_id,new Set());originalSessions.get(m.original_session_id).add(sessions.get(m.session_id));}
 }
 if(new Set(turns.values()).size!==turns.size||new Set(sessions.values()).size!==sessions.size)throw Error('opaque_collision');
 const messages=subject.messages.map(m=>({id:turns.get(m.id),session_id:sessions.get(m.session_id),role:m.role,content:m.content,date:m.date}));
 const probes=subject.probes.map(p=>({...p,gold_ids:p.gold_ids.map(id=>{if(!turns.has(id))throw Error('unresolved_gold');return turns.get(id);}),gold_session_ids:[...new Set((p.gold_session_ids??[]).flatMap(id=>{if(!originalSessions.has(id))throw Error('unresolved_gold_session');return [...originalSessions.get(id)];}))]}));
 return {subject:{...subject,messages,probes},evaluator_only_alignment:{turn_ids:Object.fromEntries(turns),session_ids:Object.fromEntries(sessions)},version:'opaque-source-v1'};
}
