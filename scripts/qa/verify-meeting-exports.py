#!/usr/bin/env python3
"""Independent PDF parsing, subtitle ground truth and complete Poppler rendering."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
from pypdf import PdfReader


def compact(text):
    return re.sub(r'\s+', '', text)


def milliseconds(timestamp):
    hours, minutes, seconds = timestamp.replace(',', '.').split(':')
    return round((int(hours) * 3600 + int(minutes) * 60 + float(seconds)) * 1000)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--render', required=True, type=Path)
    args = parser.parse_args()
    args.render.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((args.input / 'manifest.json').read_text())
    assert manifest['deniedRequests'] == 0 and manifest['providerMutationRequests'] == 0
    assert manifest['audioUnchanged'] and not manifest['pageErrors']
    results = []
    for artifact in manifest['artifacts']:
        path = args.input / artifact['filename']
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == artifact['sha256']
        preview = json.loads((args.input / artifact['preview']).read_text())
        source, selection = preview['snapshot'], preview['selection']
        if path.suffix == '.pdf':
            pdf = PdfReader(path)
            assert len(pdf.pages) >= (2 if artifact['name'] == 'long' else 1)
            assert pdf.metadata.title == source['title']
            assert source['sourceRevision'] in str(pdf.metadata)
            assert source['generatedAt'] in str(pdf.metadata)
            extracted = []
            for index, page in enumerate(pdf.pages):
                assert abs(float(page.mediabox.width) - 595.28) < .1
                assert abs(float(page.mediabox.height) - 841.89) < .1
                text = page.extract_text()
                assert '\ufffd' not in text and 'PRIVATE_EXPORT_SENTINEL' not in text
                footer = f"Source {source['sourceRevision'][:12]} · v{source['sourceVersion']} · {index + 1}/{len(pdf.pages)}"
                assert footer in text
                extracted.append(text.replace(footer, ''))
            text = '\n'.join(extracted)
            flattened = compact(text)
            assert source['sourceRevision'] in flattened
            expected = []
            if selection['transcript']:
                expected.extend(segment['text'] for segment in source['segments'] if segment['text'].strip())
                if not source['segments']:
                    expected.append(source['transcript'])
            if selection['notes']:
                expected.append(source['notes']['text'])
                assert ('Unknown source' if source['notes']['sourceRevision'] is None else source['notes']['sourceRevision']) in text
            for task in source['tasks']:
                assert task['id'] in selection['taskIds']
                expected.extend(value for value in [task['title'], task['description'], task['assignee'], task['dueDate']] if value)
                assert ('Completed:' if task['status'] == 'completed' else 'Open:') in text
            cursor = 0
            for value in expected:
                position = flattened.find(compact(value), cursor)
                assert position >= 0, f"Missing/reordered literal content in {artifact['name']}"
                cursor = position + len(compact(value))
            assert ('Reviewed notes' in text) == selection['notes']
            assert ('Reviewed tasks' in text) == bool(selection['taskIds'])
            (args.render / f"{artifact['name']}.txt").write_text(text)
            prefix = args.render / artifact['name']
            subprocess.run(['pdftoppm', '-r', '90', '-png', str(path), str(prefix)], check=True, capture_output=True)
            assert len(list(args.render.glob(f"{artifact['name']}-*.png"))) == len(pdf.pages)
            results.append({'name': artifact['name'], 'pages': len(pdf.pages), 'literalReadingOrder': True})
        else:
            text = data.decode('utf-8', errors='strict')
            assert '\r' not in text and text.endswith('\n')
            if path.suffix == '.vtt':
                assert text.startswith('WEBVTT\n\nNOTE Source ')
                assert source['sourceRevision'] in text
            matches = re.findall(r'(\d+)\n([\d:,\.]+) --> ([\d:,\.]+)\n(.*?)(?:\n\n|\Z)', text, re.S)
            segments = sorted(enumerate(source['segments']), key=lambda item: (round(item[1]['start'] * 1000), round(item[1]['end'] * 1000), item[0]))
            segments = [segment for _, segment in segments if segment['text'].strip()]
            assert len(matches) == len(segments)
            for index, (cue, segment) in enumerate(zip(matches, segments)):
                number, start, end, encoded = cue
                assert int(number) == index + 1
                assert milliseconds(start) == round(segment['start'] * 1000)
                assert milliseconds(end) == round(segment['end'] * 1000)
                expected = (segment['speaker'] + ': ' if selection['speakers'] and segment['speaker'] else '') + segment['text']
                assert compact(html.unescape(encoded)) == compact(expected)
            results.append({'name': artifact['name'], 'cues': len(matches), 'literalDecodedText': True})
    (args.render / 'verification.json').write_text(json.dumps({'parser': 'pypdf', 'results': results}, indent=2))
    print(json.dumps({'verified': len(results), 'pages': sum(result.get('pages', 0) for result in results)}))


if __name__ == '__main__':
    main()
