import {adaptBeam} from './v9-beam-adapter.mjs';
export const BEAM_DATE_NOTICE='Date metadata below denotes the supplied time anchor for a conversation batch, not a timestamp asserted for every event. Use explicit event dates in the text when available.\n\n';
export function adaptBeamV11(row){
 let inherited=0,missing=0;const chat=row.chat.map(batch=>{let anchor=null;return batch.map(m=>{if(typeof m.time_anchor==='string'&&Number.isFinite(Date.parse(m.time_anchor)))anchor=m.time_anchor;if(!m.time_anchor&&anchor){inherited++;return {...m,time_anchor:anchor};}if(!m.time_anchor)missing++;return m;});});
 const result=adaptBeam({...row,chat});return {...result,audit:{...result.audit,inherited_batch_anchors:inherited,missing_batch_anchors:missing,date_semantics:'carry forward only explicit anchor within same outer batch; not individual event timestamp'}};
}
