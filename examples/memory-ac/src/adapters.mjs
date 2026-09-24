import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const SEED = '20260824';

// Split by UTF-16 length (the Gateway Zod limit), preserving every character.
export function chunks(text, max = 6000) {
  if (!text) throw new Error('Empty message: cannot silently drop it');
  const out = [];
  let current = '';
  for (const char of text) {
    if (current.length + char.length > max) { out.push(current); current = ''; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

export function longmem(raw, cap = 120) {
  // Connected components of shared answer sessions, including abstention twins.
  const parent = raw.map((_, i) => i);
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  const seen = new Map();
  raw.forEach((q, i) => {
    for (const key of [...q.answer_session_ids, `question:${q.question_id.replace(/_abs$/, '')}`]) {
      if (seen.has(key)) parent[root(i)] = root(seen.get(key));
      else seen.set(key, i);
    }
  });
  const groups = new Map();
  raw.forEach((q, i) => { const k = root(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q); });
  const ordered = [...groups.values()].map(items => ({items, key:items.map(q=>q.question_id).sort().join('|')}))
    .sort((a,b)=>hash(`${SEED}:sample:${a.key}`).localeCompare(hash(`${SEED}:sample:${b.key}`)));
  const selected = []; let count = 0;
  for (const group of ordered) if (count + group.items.length <= cap) { selected.push(group); count += group.items.length; }
  const subjects = [];
  for (const group of selected) {
    const random = parseInt(hash(`${SEED}:split:${group.key}`).slice(0,8),16) / 2**32;
    const split = random < .6 ? 'train' : random < .8 ? 'dev' : 'test';
    for (const q of group.items) {
      const subject_id = `longmem:${q.question_id}`;
      const messages = [];
      q.haystack_sessions.forEach((session, si) => session.forEach((m, ti) => {
        messages.push({id:`${si}:${q.haystack_session_ids[si]}:${ti}`, session_id:`${si}:${q.haystack_session_ids[si]}`, original_session_id:q.haystack_session_ids[si],
          role:m.role, content:m.content, date:q.haystack_dates[si], gold:m.has_answer === true});
      }));
      const gold = messages.filter(m=>m.gold).map(m=>m.id);
      const abstention = q.question_id.endsWith('_abs');
      subjects.push({dataset:'longmemeval_s', subject_id, group_id:hash(group.key).slice(0,16), split, messages,
        probes:[{id:subject_id, query:q.question, category:q.question_type, answer:q.answer,
          gold_ids:gold, gold_session_ids:q.answer_session_ids,
          exclusion:abstention ? 'abstention' : gold.length ? null : 'missing_turn_labels'}]});
    }
  }
  return subjects;
}

export function locomo(raw) {
  return raw.map(c => {
    const subject_id = `locomo:${c.sample_id}`;
    const messages = [];
    for (const key of Object.keys(c.conversation).filter(k=>/^session_\d+$/.test(k)).sort((a,b)=>Number(a.split('_')[1])-Number(b.split('_')[1]))) {
      for (const m of c.conversation[key]) messages.push({id:m.dia_id, session_id:key,
        role:m.speaker === c.conversation.speaker_a ? 'user' : 'assistant',
        // Preserve actual supplied speaker/image descriptions; no generated captions.
        content:`${m.speaker}: ${m.text}${m.blip_caption ? `\n[Image description: ${m.blip_caption}]` : ''}`,
        date:c.conversation[`${key}_date_time`]});
    }
    const available = new Set(messages.map(m=>m.id));
    return {dataset:'locomo',subject_id,group_id:subject_id,split:'external',messages,
      probes:c.qa.map((q,i)=>{
        const evidence=(q.evidence ?? []).flatMap(e=>e.match(/D\d+:\d+/g) ?? []);
        const malformed=(q.evidence ?? []).some(e=>e.replace(/D\d+:\d+/g,'').replace(/[\s;,]/g,'').length>0);
        const gold_ids=[...new Set(evidence)];
        return {id:`${subject_id}:q${i}`,query:q.question,category:String(q.category),answer:q.answer,
          gold_ids,gold_session_ids:[],exclusion:Number(q.category)===5?'adversarial':malformed?'malformed_evidence':
          !gold_ids.length?'missing_evidence':gold_ids.some(id=>!available.has(id))?'unresolved_evidence':null};
      })};
  });
}

export function validate(subjects) {
  const ids=new Set();
  for(const s of subjects) {
    if(ids.has(s.subject_id)) throw new Error(`Duplicate subject ${s.subject_id}`); ids.add(s.subject_id);
    const turns=new Set();
    for(const m of s.messages){if(turns.has(m.id))throw new Error('Duplicate turn');turns.add(m.id);if(!m.content)throw new Error('Empty message');}
    for(const p of s.probes) if(!p.exclusion && p.gold_ids.some(id=>!turns.has(id)))throw new Error('Unresolvable gold');
  }
}
