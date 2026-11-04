import {adaptBeamV11, BEAM_DATE_NOTICE} from './v9-beam-adapter-v1-1.mjs';
import {opaqueSourceIds} from './opaque-provenance.mjs';
import {validate} from './adapters.mjs';

// Canonical boundary also accepts internal data normalized by a separate connector.
export function adaptRows(rows, {adapter, split}) {
  if (!['beam', 'normalized'].includes(adapter) || !['train', 'development', 'calibration'].includes(split)) throw Error('adapter_or_split');
  const selected = rows.filter(x => x.split === split);
  const result = selected.map(row => adapter === 'beam'
    ? {...adaptBeamV11(row), context_prefix: BEAM_DATE_NOTICE}
    : {...opaqueSourceIds(row), context_prefix: ''});
  validate(result.map(x => x.subject));
  if (result.some(x => x.subject.split === 'protected_test')) throw Error('protected_data');
  return result;
}
