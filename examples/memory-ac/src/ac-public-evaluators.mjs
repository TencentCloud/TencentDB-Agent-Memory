import {readerMessages, parseVerdict} from './paired-eval.mjs';
import {evaluationMessages} from './evaluation-adapters.mjs';
import {beamJudgeMessages} from './v9-beam-adapter.mjs';
export const publicEvaluators = Object.freeze({
  longmem: {readerMessages, judgeMessages: evaluationMessages, parseVerdict},
  locomo: {readerMessages, judgeMessages: evaluationMessages, parseVerdict},
  beam: {readerMessages, judgeMessages: beamJudgeMessages, parseVerdict},
});
