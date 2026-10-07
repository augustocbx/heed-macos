import unittest

from final_echo import is_microphone_echo


def segment(start, end, text):
    return {"start": start, "end": end, "text": text}


class FinalEchoTests(unittest.TestCase):
    def test_same_phrase_with_acoustic_delay_is_echo(self):
        self.assertTrue(is_microphone_echo(
            segment(10.2, 13.2, "We can begin the meeting now."),
            [segment(10, 13, "We can begin the meeting now.")]))

    def test_portuguese_unicode_case_and_punctuation_are_equivalent(self):
        self.assertTrue(is_microphone_echo(
            segment(0.1, 3.1, "NÃO, vamos começar a reunião!"),
            [segment(0, 3, "na\u0303o vamos comecar a reunia\u0303o")]))

    def test_short_ambiguous_acknowledgment_is_preserved(self):
        for text in ("Sim", "Okay", "Thank you", "Vamos lá"):
            with self.subTest(text=text):
                self.assertFalse(is_microphone_echo(
                    segment(0, 1, text), [segment(0, 1, text)]))

    def test_microphone_phrase_survives_without_system_speech(self):
        self.assertFalse(is_microphone_echo(
            segment(8, 11, "I have a separate question."), []))

    def test_same_words_in_another_time_window_are_preserved(self):
        self.assertFalse(is_microphone_echo(
            segment(8, 11, "I have a separate question."),
            [segment(0, 3, "I have a separate question.")]))

    def test_simultaneous_different_local_speech_is_preserved(self):
        self.assertFalse(is_microphone_echo(
            segment(0, 3, "I have a separate question."),
            [segment(0, 3, "We can begin the meeting now.")]))

    def test_phrase_with_echo_and_unique_local_words_is_preserved_whole(self):
        self.assertFalse(is_microphone_echo(
            segment(0, 4, "We can begin the meeting now but I disagree."),
            [segment(0, 4, "We can begin the meeting now.")]))

    def test_one_unique_local_word_is_enough_to_preserve_whole_phrase(self):
        self.assertFalse(is_microphone_echo(
            segment(0, 3, "We cannot begin the meeting now."),
            [segment(0, 3, "We can begin the meeting now.")]))

    def test_adjacent_system_segments_can_match_one_microphone_phrase(self):
        self.assertTrue(is_microphone_echo(
            segment(0.1, 4.1, "We can begin now and discuss the next item."),
            [segment(0, 2, "We can begin now."),
             segment(2.1, 4, "And discuss the next item.")]))

    def test_one_system_segment_can_match_split_microphone_phrases(self):
        system = [segment(0, 4, "We can begin now and discuss the next item.")]
        self.assertTrue(is_microphone_echo(segment(0, 2, "We can begin now."), system))
        self.assertTrue(is_microphone_echo(
            segment(2, 4, "And discuss the next item."), system))

    def test_system_segments_separated_by_silence_do_not_form_echo_phrase(self):
        self.assertFalse(is_microphone_echo(
            segment(0, 4, "We can begin now and discuss the next item."),
            [segment(0, 1.5, "We can begin now."),
             segment(2.5, 4, "And discuss the next item.")]))

    def test_unrelated_words_between_matching_parts_do_not_form_echo_phrase(self):
        self.assertFalse(is_microphone_echo(
            segment(0, 4, "We can begin now and discuss the next item."),
            [segment(0, 2, "We can begin now after a long break."),
             segment(2, 4, "And discuss the next item.")]))

    def test_broad_system_segment_does_not_delete_coincident_local_phrase(self):
        self.assertFalse(is_microphone_echo(
            segment(8, 11, "We can begin the meeting now."),
            [segment(0, 20, "We can begin the meeting now.")]))

    def test_merged_system_phrase_does_not_match_its_other_time_half(self):
        self.assertFalse(is_microphone_echo(
            segment(2, 4, "We can begin now."),
            [segment(0, 4, "We can begin now and discuss the next item.")]))

    def test_brief_temporal_overlap_is_not_echo_evidence(self):
        self.assertFalse(is_microphone_echo(
            segment(2.5, 5.5, "We can begin the meeting now."),
            [segment(0, 3, "We can begin the meeting now.")]))

    def test_invalid_and_empty_segments_are_preserved_or_ignored(self):
        for mic in (segment(1, 1, "We can begin the meeting now."),
                    segment(0, 3, "..."),
                    segment(float("nan"), 3, "We can begin the meeting now.")):
            with self.subTest(mic=mic):
                self.assertFalse(is_microphone_echo(
                    mic, [segment(0, 3, "We can begin the meeting now.")]))
        self.assertFalse(is_microphone_echo(
            segment(0, 3, "We can begin the meeting now."),
            [segment(0, 0, "We can begin the meeting now."),
             segment(0, 3, "...")]))

    def test_input_segments_are_not_mutated(self):
        mic = segment(0, 3, "We can begin the meeting now.")
        system = [segment(0, 3, "We can begin the meeting now.")]
        expected_mic, expected_system = dict(mic), [dict(system[0])]
        self.assertTrue(is_microphone_echo(mic, system))
        self.assertEqual(mic, expected_mic)
        self.assertEqual(system, expected_system)


if __name__ == "__main__":
    unittest.main()
