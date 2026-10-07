"""Mechanics tests with synthetic IDs/vectors; not embedding quality evidence."""
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('retrieval_embeddings',Path(__file__).with_name('retrieval-embeddings.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class EmbeddingMechanics(unittest.TestCase):
    def test_window_covers_every_token_once_with_capacity_and_special_tokens(self):
        ids=list(range(400));windows=module.token_windows(ids,1000,1001)
        self.assertTrue(all(len(window)<=128 for window in windows))
        self.assertEqual([token for window in windows for token in window[1:-1]],ids)
        self.assertEqual(module.token_windows([],1000,1001),[[1000,1001]])
    def test_rrf_is_deterministic_and_does_not_double_count_repeated_ids(self):
        self.assertEqual(module.reciprocal_rank_fusion(['a','a','b'],['b','c']),['b','a','c'])
    def test_source_metrics_and_negative_retrieval_are_not_answer_correctness(self):
        score=module.retrieval_score(['one:h:0:0','one:h:1:0','two:h:0:0'],['one:h:0:0','three:h:0:0'],8)
        self.assertEqual(score['recall'],0.5);self.assertEqual(score['sourceRecall'],0.5);self.assertEqual(score['sourcePrecision'],0.5)
        self.assertTrue(module.retrieval_score(['one:h:0:0'],[],8)['negativeRetrievedIrrelevant'])
        self.assertIsNone(module.retrieval_score([],[],8)['recall'])

if __name__=='__main__': unittest.main()
