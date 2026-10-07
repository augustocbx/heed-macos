import unittest
from vocabulary_metrics import score
class MetricsTests(unittest.TestCase):
 def test_targets_false_insertions_and_unrelated_regression(self):
  result=score('João reviewed the API.','João reviewed the API. PostgreSQL',['João','API','PostgreSQL'])
  self.assertEqual(result['spokenTerms'],2);self.assertEqual(result['correctTerms'],2);self.assertEqual(result['falseInsertions'],1)
  unrelated=score('Ready now.','API',['João','API']);self.assertEqual(unrelated['spokenTerms'],0);self.assertEqual(unrelated['falseInsertions'],1);self.assertGreater(unrelated['wer'],0)
 def test_case_accent_and_word_boundaries(self):
  self.assertEqual(score('João','JOÃO',['João'])['correctTerms'],1)
  self.assertEqual(score('API','capital',['API'])['correctTerms'],0)
