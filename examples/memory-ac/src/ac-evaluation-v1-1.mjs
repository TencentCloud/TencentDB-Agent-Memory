import {hash} from './adapters.mjs';
// Dataset-neutral evaluation loop. Dataset rubrics and model/API providers are injected dependencies.
export async function* evaluatePhase({views, references, adapter, infer, phase, answers = new Map()}) {
  if (!Array.isArray(views) || !views.length || views.length > 10000 || !['reader', 'judge'].includes(phase)
    || typeof infer !== 'function' || !adapter || typeof adapter.readerMessages !== 'function'
    || typeof adapter.judgeMessages !== 'function' || typeof adapter.parseVerdict !== 'function') throw Error('evaluation_contract');
  if (views.some(v => !['train', 'development', 'calibration'].includes(v.split))
    || new Set(views.map(v => v.probe_id + '|' + v.mode)).size !== views.length) throw Error('evaluation_split_or_duplicate');
  for (const v of views) {
    if (typeof v.query !== 'string' || typeof v.context !== 'string' || hash(v.context) !== v.context_sha256) throw Error('evaluation_context_binding');
    const key = v.probe_id + '|' + v.mode;
    let messages, answer;
    if (phase === 'reader') {
      // Reference data, category, retrieval mode and hidden source labels never reach the Reader adapter.
      messages = adapter.readerMessages({query: v.query, question_date: v.question_date ?? null}, v.context);
    } else {
      answer = answers.get(key); const ref = references.get(v.probe_id);
      if (!answer || !ref) throw Error('evaluation_missing_reference_or_answer');
      if (answer.inference_failed) {
        yield {probe_id: v.probe_id, group_id: v.group_id, split: v.split, mode: v.mode,
          correct: 0, reader_key: answer.key, key: null, text: null, response_hash: null,
          evaluation_status: 'not_run_reader_failed', actual_api_call: false, cache_hit: null,
          cache_origin: 'not_applicable', prompt_tokens: 0, output_tokens: 0, elapsed_ms: 0};
        continue;
      }
      messages = adapter.judgeMessages(ref, answer.text);
    }
    const response = await infer(messages);
    if (typeof response.text !== 'string' || !response.text.trim()) throw Error('evaluation_empty_response');
    const row = {...response, probe_id: v.probe_id, group_id: v.group_id, split: v.split, mode: v.mode};
    if (phase === 'judge') {
      row.correct = adapter.parseVerdict(response.text);
      if (![0, 1].includes(row.correct)) throw Error('evaluation_nonbinary_verdict');
      row.reader_key = answer.key;
    } else row.context_sha256 = v.context_sha256;
    yield row;
  }
}
