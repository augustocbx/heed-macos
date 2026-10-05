import unittest
from voice_identity import reconcile_names


class VoiceIdentityTests(unittest.TestCase):
    def test_live_names_follow_embeddings_when_cluster_order_changes(self):
        live = [{'name': 'Ana', 'emb': [1, 0], 'backend': 'wespeaker'},
                {'name': 'Bia', 'emb': [0, 1], 'backend': 'wespeaker'}]
        result = reconcile_names({0: [0, 1], 1: [1, 0]}, {}, live, 'wespeaker')
        self.assertEqual(result, {0: 'Bia', 1: 'Ana'})

    def test_unknown_and_ambiguous_voices_stay_unnamed(self):
        live = [{'name': 'Ana', 'emb': [1, 0], 'backend': 'wespeaker'},
                {'name': 'Bia', 'emb': [.99, .1], 'backend': 'wespeaker'}]
        self.assertEqual(reconcile_names({0: [1, 0], 1: [-1, 0]}, {}, live, 'wespeaker'), {})

    def test_incompatible_backend_and_invalid_vectors_cannot_match(self):
        live = [{'name': 'Ana', 'emb': [1, 0], 'backend': 'pyannote'},
                {'name': 'Bia', 'emb': [float('nan'), 0], 'backend': 'wespeaker'}]
        self.assertEqual(reconcile_names({0: [1, 0], 1: [1, 0, 0]}, {}, live, 'wespeaker'), {})

    def test_final_recognition_takes_precedence(self):
        live = [{'name': 'Ana', 'emb': [1, 0], 'backend': 'wespeaker'}]
        self.assertEqual(reconcile_names({0: [1, 0]}, {0: 'Bia'}, live, 'wespeaker'), {0: 'Bia'})

    def test_single_unknown_pure_microphone_voice_uses_configured_name(self):
        self.assertEqual(reconcile_names({0: [1, 0], 1: [0, 1]}, {}, [], 'wespeaker',
                                        {0: {'mic'}, 1: {'sys'}}, 'Augusto'), {0: 'Augusto'})

    def test_multiple_mic_voices_and_echo_do_not_inherit_owner_name(self):
        for channels in ({0: {'mic'}, 1: {'mic'}}, {0: {'mic', 'sys'}, 1: {'sys'}}):
            self.assertEqual(reconcile_names({0: [1, 0], 1: [0, 1]}, {}, [], 'wespeaker',
                                            channels, 'Augusto'), {})

    def test_recognized_mic_voice_is_not_replaced_by_configured_name(self):
        self.assertEqual(reconcile_names({0: [1, 0]}, {0: 'Ana'}, [], 'wespeaker',
                                        {0: {'mic'}}, 'Augusto'), {0: 'Ana'})


if __name__ == '__main__':
    unittest.main()
