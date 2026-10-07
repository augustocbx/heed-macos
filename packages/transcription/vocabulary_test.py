import unittest
from vocabulary import configuration, validate_snapshot

def snapshot(entries=None, additions=None):
 return {'schemaVersion':1,'libraryVersion':2,'glossaryId':'work','glossaryVersion':1,'entries':entries or [],'additions':additions or []}

class VocabularyTests(unittest.TestCase):
 def test_context_preserves_unicode_and_language_filter(self):
  value=snapshot([{'term':'João','hint':'John','language':'pt'},{'term':'TypeScript'},{'term':'English only','language':'en'}])
  result=configuration(value,'mlx','base','pt')
  self.assertEqual(result['status'],'recognition-context')
  self.assertEqual(result['prompt'],'João (John), TypeScript')
  self.assertEqual(result['excludedEntries'],[value['entries'][2]])
  self.assertEqual(configuration(value,'parakeet','parakeet-v3','pt')['status'],'unsupported')
  self.assertIsNone(configuration(value,'parakeet','parakeet-v3','pt')['prompt'])
 def test_invalid_snapshot_and_duplicates_are_rejected(self):
  for entries in [[{'term':''}],[{'term':'API'},{'term':'api'}],[{'term':'José'},{'term':'Jose\u0301'}],[{'term':'bad\x00'}],[{'term':'x','language':'xx'}],[{'term':'x','hint':'a'*121}]]:
   with self.assertRaises(ValueError):validate_snapshot(snapshot(entries))
  with self.assertRaises(ValueError):validate_snapshot({**snapshot(),'unexpected':True})
 def test_prompt_budget_is_explicit_and_empty_has_no_hint(self):
  value=snapshot([{'term':str(i)+'x'*100} for i in range(40)])
  result=configuration(value,'ctranslate2','small','en')
  self.assertLessEqual(len(result['prompt']),1500)
  self.assertTrue(result['excludedEntries'])
  self.assertEqual(configuration(snapshot(),'mlx','base','en')['status'],'empty')
