"""Bounded local vocabulary context. Never replaces recognized text or speaker names."""
import copy
import re
import unicodedata

EMPTY = {'schemaVersion': 1, 'libraryVersion': 0, 'glossaryId': None,
         'glossaryVersion': None, 'entries': [], 'additions': []}


def _text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value.encode('utf-16-le', errors='surrogatepass')) // 2 > maximum or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in value):
        raise ValueError('Invalid vocabulary text')
    return value


def _entries(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError('Vocabulary supports at most 100 entries')
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or set(entry) - {'term', 'hint', 'language'}:
            raise ValueError('Invalid vocabulary entry')
        _text(entry.get('term'), 120)
        if 'hint' in entry:
            _text(entry['hint'], 120)
        if 'language' in entry and entry['language'] not in ('en', 'pt'):
            raise ValueError('Invalid vocabulary language')
        key = (entry.get('language'), unicodedata.normalize('NFC', entry['term']).strip().lower())
        if any(prior[1] == key[1] and (prior[0] is None or key[0] is None or prior[0] == key[0]) for prior in seen):
            raise ValueError('Duplicate vocabulary term')
        seen.add(key)
    return copy.deepcopy(value)


def validate_snapshot(value):
    if value is None:
        return copy.deepcopy(EMPTY)
    if not isinstance(value, dict) or set(value) != set(EMPTY) or value.get('schemaVersion') != 1:
        raise ValueError('Invalid vocabulary snapshot')
    version, glossary, revision = value['libraryVersion'], value['glossaryId'], value['glossaryVersion']
    if type(version) is not int or not 0 <= version <= 9007199254740991 or (glossary is not None and (not isinstance(glossary, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', glossary))) or ((glossary is None) != (revision is None)) or (revision is not None and (type(revision) is not int or not 1 <= revision <= 9007199254740991)):
        raise ValueError('Invalid vocabulary snapshot version')
    entries, additions = _entries(value['entries']), _entries(value['additions'])
    _entries(entries + additions)
    return {**value, 'entries': entries, 'additions': additions}


def configuration(value, engine, model, language):
    snapshot = validate_snapshot(value)
    entries = snapshot['entries'] + snapshot['additions']
    used, excluded, phrases = [], [], []
    supported = engine in ('mlx', 'ctranslate2')
    for entry in entries:
        phrase = entry['term'] + (f" ({entry['hint']})" if entry.get('hint') else '')
        candidate = ', '.join(phrases + [phrase])
        if not supported or entry.get('language', language) != language or len(candidate.encode('utf-16-le')) // 2 > 1500:
            excluded.append(entry)
        else:
            used.append(entry)
            phrases.append(phrase)
    prompt = ', '.join(phrases) or None
    return {'engine': engine, 'model': model, 'language': language,
            'status': 'unsupported' if entries and not supported else 'recognition-context' if prompt else 'empty',
            'interface': 'initial_prompt' if supported else None, 'prompt': prompt,
            'usedEntries': used, 'excludedEntries': excluded}


def run(value, engine, model, language):
    snapshot = validate_snapshot(value)
    return {'schemaVersion': 1, 'snapshot': snapshot, 'configuration': configuration(snapshot, engine, model, language)}


def options(config):
    return {'initial_prompt': config['prompt']} if config['prompt'] else {}
