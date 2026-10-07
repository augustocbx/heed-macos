# Meeting export fixtures

These synthetic texts were authored for this repository. They contain no meeting recordings or personal transcripts. The accented names are fictional; the HTML, entities and arrows deliberately exercise literal text handling. `cases.json` is the ground truth for cue text and source ordering. The runner repeats authored text to produce a multi-page document and creates a one-second silent PCM WAV inside its temporary, isolated application directory. No fixture uses a remote font, image or provider.

The four-language sample tests English, Brazilian Portuguese, French and German characters, including a decomposed combining accent. Subtitle wrapping preserves graphemes, replaces repeated blank lines with a single line boundary, and escapes format markup; decoded visible text is compared under that policy.
