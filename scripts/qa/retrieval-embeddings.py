#!/usr/bin/env python3
"""Explicit, offline, CPU-only QA experiment. Never an application provider."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import threading
import time

MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
REVISION = 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42'
MAX_ARTIFACT = 1_073_741_824
MAX_RSS = 2_147_483_648


def token_windows(ids, cls, sep, limit=128):
    if limit != 128 or cls is None or sep is None:
        raise ValueError('Expected the pinned 128-token model and local special tokens')
    return [[cls, *ids[start:start + limit - 2], sep] for start in range(0, max(1, len(ids)), limit - 2)]


def retrieval_score(ids, relevant, k):
    returned = list(dict.fromkeys(ids))[:k]
    truth = set(relevant)
    correct = len(truth.intersection(returned))
    sources = {id.split(':', 1)[0] for id in returned}
    truth_sources = {id.split(':', 1)[0] for id in truth}
    return {'recall': correct / len(truth) if truth else None,
            'precision': correct / len(returned) if returned else None,
            'sourceRecall': len(sources & truth_sources) / len(truth_sources) if truth_sources else None,
            'sourcePrecision': len(sources & truth_sources) / len(sources) if sources else None,
            'returned': len(returned), 'relevant': len(truth),
            'negativeRetrievedIrrelevant': not truth and bool(returned)}


def reciprocal_rank_fusion(lexical, semantic):
    scores = {}
    for ranking in [lexical, semantic]:
        for rank, id in enumerate(dict.fromkeys(ranking), 1):
            scores[id] = scores.get(id, 0) + 1 / (60 + rank)
    return sorted(scores, key=lambda id: (-scores[id], id))


def rss():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == 'darwin' else value * 1024)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for data in iter(lambda: file.read(1_048_576), b''):
            digest.update(data)
    return digest.hexdigest()


def verify_model(path):
    manifest_path = path / 'qa-manifest.json'
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 65536:
        raise ValueError('Unsafe model manifest')
    manifest = json.loads(manifest_path.read_text())
    if manifest['model'] != MODEL or manifest['revision'] != REVISION or manifest['license'] != 'apache-2.0':
        raise ValueError('Unapproved model/revision/license')
    expected = {'README.md','config.json','onnx/model.onnx','sentence_bert_config.json','special_tokens_map.json','tokenizer.json','tokenizer_config.json'}
    if {f['file'] for f in manifest['files']} != expected or len(manifest['files']) != len(expected):
        raise ValueError('Unexpected pinned model artifact set')
    total = 0
    for file in manifest['files']:
        target = path / file['file']
        if target.is_symlink() or not target.is_file() or target.stat().st_size != file['bytes']:
            raise ValueError('Model file identity changed')
        total += target.stat().st_size
        if total > MAX_ARTIFACT or sha(target) != file['sha256']:
            raise ValueError('Model artifact size or digest limit')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--checkout-root', type=Path, default=Path(__file__).resolve().parents[2],
                        help='Repository checkout to keep QA artifacts outside when running a copied script')
    parser.add_argument('--offline-child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = args.checkout_root.resolve()
    for path in [args.model, args.input, args.output]:
        if path.resolve().is_relative_to(root):
            parser.error('QA model/input/output must remain outside the checkout')
    if not args.offline_child:
        if sys.platform != 'darwin' or not Path('/usr/bin/sandbox-exec').is_file():
            parser.error('A verified outbound-network sandbox is required for this QA command')
        command = ['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network-outbound)',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:],'--offline-child']
        return subprocess.run(command, env={**os.environ, 'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','TOKENIZERS_PARALLELISM':'false'}, check=False).returncode
    started = time.monotonic()
    manifest = verify_model(args.model)
    if args.input.is_symlink() or args.input.stat().st_size > 67_108_864:
        raise ValueError('Input size limit')
    with args.input.open('rb') as file:
        raw = file.read(67_108_865)
    if len(raw) > 67_108_864:
        raise ValueError('Input grew beyond its limit')
    data = json.loads(raw)
    evidence, questions = data['evidence'], data['questions']
    if not evidence or len(evidence) > 10000 or len(questions) > 128:
        raise ValueError('QA corpus limit')
    ids = [item['id'] for item in evidence]
    if len(set(ids)) != len(ids) or any(len(item['quote']) > 1200 or item['transcriptVersion'] < 0 or len(item['sourceRevision']) != 64 for item in evidence):
        raise ValueError('Invalid current-source evidence identity')
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1; options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(str(args.model / 'onnx/model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    if session.get_providers() != ['CPUExecutionProvider']:
        raise ValueError('CPU-only provider required')
    tokenizer = Tokenizer.from_file(str(args.model / 'tokenizer.json'))
    tokenizer.no_truncation(); tokenizer.no_padding()
    special = json.loads((args.model / 'special_tokens_map.json').read_text())
    cls = tokenizer.token_to_id(special['cls_token']); sep = tokenizer.token_to_id(special['sep_token']); pad = tokenizer.token_to_id(special['pad_token'])
    if pad is None:
        raise ValueError('Missing pinned padding token')
    cold = time.monotonic() - started
    monitor_stop = threading.Event(); exceeded = threading.Event(); run = ort.RunOptions()
    def monitor():
        while not monitor_stop.wait(0.05):
            if rss() > MAX_RSS:
                exceeded.set(); run.terminate = True
    thread = threading.Thread(target=monitor, daemon=True); thread.start()
    def check_memory():
        if exceeded.is_set() or rss() > MAX_RSS:
            raise MemoryError('QA RSS exceeded 2 GiB; no quality result is granted')
    def embed(texts):
        check_memory()
        windows, owners, weights = [], [], []
        for owner, text in enumerate(texts):
            parts = token_windows(tokenizer.encode(text, add_special_tokens=False).ids, cls, sep)
            for part in parts:
                windows.append(part); owners.append(owner); weights.append(max(1,len(part)-2))
        vectors = np.zeros((len(texts),384), dtype=np.float64); totals = np.zeros(len(texts))
        for start in range(0,len(windows),8):
            parts = windows[start:start+8]; width = max(map(len,parts))
            token_ids = np.full((len(parts),width),pad,dtype=np.int64); mask = np.zeros_like(token_ids)
            for row, part in enumerate(parts): token_ids[row,:len(part)] = part; mask[row,:len(part)] = 1
            feeds = {'input_ids':token_ids,'attention_mask':mask,'token_type_ids':np.zeros_like(token_ids)}
            outputs = session.run(None,{item.name:feeds[item.name] for item in session.get_inputs()},run)
            hidden = next((output for output in outputs if output.ndim == 3 and output.shape[-1] == 384),None)
            if hidden is None: raise ValueError('Expected actual 384-dimensional token embeddings for mean pooling')
            pooled = (hidden * mask[:,:,None]).sum(axis=1) / mask.sum(axis=1)[:,None]
            for offset, vector in enumerate(pooled):
                owner = owners[start+offset]; weight = weights[start+offset]
                vectors[owner] += vector * weight; totals[owner] += weight
            check_memory()
        vectors /= totals[:,None]
        vectors /= np.maximum(np.linalg.norm(vectors,axis=1,keepdims=True),1e-12)
        return vectors.astype(np.float32)
    report = {'schemaVersion':1,'model':MODEL,'revision':REVISION,'license':'apache-2.0','artifacts':manifest['files'],'inputSha256':hashlib.sha256(raw).hexdigest(),'hardware':platform.platform(),'runtime':{name:importlib.metadata.version(name) for name in ['onnxruntime','tokenizers','numpy']},'provider':'CPUExecutionProvider','inferenceWorkers':1,'batch':8,'tokenWindow':128,'coldLoadSeconds':cold,'qualityKind':'actual embeddings; no language-generation correctness claim','questions':[]}
    try:
        index_started = time.monotonic(); vectors = embed([item['quote'] for item in evidence]); report['sourceEmbeddingSeconds'] = time.monotonic()-index_started
        for question in questions:
            eligible = set(question['eligibleSessionIds']); indices = [index for index,item in enumerate(evidence) if item['sessionId'] in eligible]
            query_started = time.monotonic(); vector = embed([question['question']])[0]
            # Eligibility is applied before similarity and ranking, never afterwards.
            similarities = vectors[indices] @ vector
            ranked = sorted(zip(indices,similarities),key=lambda pair:(-float(pair[1]),ids[pair[0]]))
            ranking = [ids[index] for index,_score in ranked[:64]]
            lexical = question.get('lexicalIds',[])
            if any(id not in {ids[index] for index in indices} for id in lexical): raise ValueError('Excluded lexical input')
            hybrid = reciprocal_rank_fusion(lexical,ranking)
            report['questions'].append({'id':question['id'],'language':question['language'],'kind':question['kind'],'eligibleEvidence':len(indices),'warmQuerySeconds':time.monotonic()-query_started,'embeddingIds':ranking,'hybridIds':hybrid[:64] if 'lexicalIds' in question else None,'embedding':{str(k):retrieval_score(ranking,question['relevantEvidenceIds'],k) for k in [8,16]},'hybrid':{str(k):retrieval_score(hybrid,question['relevantEvidenceIds'],k) for k in [8,16]} if 'lexicalIds' in question else None})
        incremental_started=time.monotonic(); embed([evidence[0]['quote']]); report['incrementalSourceSeconds']=time.monotonic()-incremental_started
        report['observedPeakRssBytes']=rss(); check_memory(); report['resourceLimitPassed']=True
    except Exception as error:
        report['error']=str(error); report['observedPeakRssBytes']=rss(); report['resourceLimitPassed']=False
        raise
    finally:
        monitor_stop.set(); thread.join(timeout=1)
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'questions':len(report['questions']),'peakRssBytes':report['observedPeakRssBytes'],'sourceEmbeddingSeconds':report['sourceEmbeddingSeconds']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
