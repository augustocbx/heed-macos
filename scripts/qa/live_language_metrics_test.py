import unittest
from live_language_metrics import score_fixture

class MetricsTests(unittest.TestCase):
    def test_normalization_preserves_accents_and_normalizes_nfc(self):
        self.assertEqual(score_fixture('Olá, JOÃO!', 'ola joao', [])['wer'], 1.0)
        self.assertEqual(score_fixture('ação', 'acao', [])['cer'], .5)
        self.assertEqual(score_fixture('Olá João', 'OLA\u0301 JOÃO!', [])['cer'], 0)
    def test_known_omission_duplication_and_name_term_preservation(self):
        spans=[{'id':'a','language':'pt','text':'João revisou Kubernetes','languageAnchors':['revisou'],'names':['João'],'terms':['Kubernetes'],'start':0,'end':2}]
        score=score_fixture(spans[0]['text'],'João Kubernetes João Kubernetes',spans)
        self.assertAlmostEqual(score['wer'],2/3)
        self.assertEqual(score['names']['preserved'],1);self.assertEqual(score['terms']['preserved'],1)
        self.assertEqual(score['spans']['missed'],0);self.assertEqual(score['spans']['languagePreserved'],0)
    def test_language_field_cannot_disguise_translation(self):
        spans=[{'id':'a','language':'pt','text':'Bom dia','languageAnchors':['bom','dia'],'translatedAlternatives':['Good morning'],'start':0,'end':2}]
        score=score_fixture('Bom dia',[{'text':'Good morning','language':'pt','start':0,'end':2}],spans)
        self.assertEqual(score['spans']['translated'],1);self.assertEqual(score['spans']['languagePreserved'],0)
        original=score_fixture('Bom dia',[{'text':'Bom dia','language':'en','start':.2,'end':2.1}],spans)
        self.assertEqual(original['spans']['languagePreserved'],1)
        self.assertAlmostEqual(original['timestamps']['meanAbsoluteErrorSeconds'],.15)
    def test_mixed_per_language_alignment_and_exact_duplicate(self):
        spans=[{'id':'pt','language':'pt','text':'Bom dia','languageAnchors':['bom','dia']},{'id':'en','language':'en','text':'Ready now','languageAnchors':['ready','now']}]
        score=score_fixture('Bom dia Ready now','Bom dia Ready now Ready now',spans)
        self.assertEqual(score['perLanguage']['pt']['wer'],0)
        self.assertEqual(score['spans']['duplicated'],1)
        self.assertEqual(score['spans']['languagePreserved'],2)
        self.assertTrue(score['manualLanguageReviewRequired'])
    def test_silence_has_no_undefined_error_rate_or_hidden_hallucination(self):
        empty=score_fixture('','',[]);self.assertEqual(empty['wer'],0);self.assertFalse(empty['silenceHallucination'])
        noise=score_fixture('','Obrigado',[]);self.assertIsNone(noise['wer']);self.assertTrue(noise['silenceHallucination']);self.assertEqual(noise['insertions'],1)

if __name__=='__main__':unittest.main()
