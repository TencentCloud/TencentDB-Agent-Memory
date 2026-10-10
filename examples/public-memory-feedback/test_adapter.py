import copy
import unittest
from prepare import adapt,normalized
from analyze import score


def fixture():
 return [{'sample_id':'conv-fixture','conversation':{
  'session_1':[{'dia_id':'D1:1','speaker':'A','text':'My database is PostgreSQL.'}],
  'session_1_date_time':'2026-01-01'},
  'qa':[{'question':'Which database does A use?','answer':'PostgreSQL','category':4,'evidence':['D1:1']}]}]


class AdapterTests(unittest.TestCase):
 def test_no_answer_or_evidence_labels_in_runtime_input(self):
  x,l,m,e=adapt(fixture())
  self.assertEqual(set(x[0]['queries'][0]),{'id','question'})
  self.assertEqual(x[0]['memories'][0]['content'],'A: My database is PostgreSQL.')
  self.assertEqual(l['conv-fixture/Q000']['evidence_ids'],['conv-fixture/D1:1'])

 def test_invalid_missing_duplicate_citations_rejected(self):
  for ev in [[],['D9:9'],['D1:1','D1:1']]:
   x=fixture();x[0]['qa'][0]['evidence']=ev
   self.assertEqual(len(adapt(x)[1]),0)

 def test_image_and_nonliteral_answers_not_training_feedback(self):
  x=fixture();x[0]['conversation']['session_1'][0]['img_url']='https://example.invalid/image'
  self.assertEqual(len(adapt(x)[1]),0)
  x=fixture();x[0]['qa'][0]['answer']='MySQL'
  self.assertEqual(len(adapt(x)[1]),0)

 def test_answer_in_question_is_excluded(self):
  x=fixture();x[0]['qa'][0]['question']='Does A use PostgreSQL?'
  self.assertEqual(len(adapt(x)[1]),0)

 def test_oversize_source_rejected_without_truncation(self):
  x=fixture();x[0]['conversation']['session_1'][0]['text']='x'*9000
  with self.assertRaises(ValueError):adapt(x)

 def test_full_word_grounding_does_not_match_substrings(self):
  x=fixture();x[0]['qa'][0]['answer']='postgre'
  self.assertEqual(len(adapt(x)[1]),0)
  self.assertEqual(normalized('PostgreSQL!'),'postgresql')

 def test_effect_failure_differs_from_infrastructure_error(self):
  label={'evidence_ids':['a']}
  self.assertEqual(score({'status':'observed','entry_ids':['b']},label)['status'],'fail')
  self.assertIsNone(score({'status':'error'},label)['recall'])
  self.assertEqual(score({'status':'observed','entry_ids':['a']},label)['status'],'pass')


if __name__=='__main__':unittest.main()
