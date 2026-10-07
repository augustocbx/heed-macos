#!/usr/bin/env python3
"""Paired offline vocabulary evaluation through existing Heed engine wrappers.

Uses authored licensed fixtures by default. External consented manifests can use the
same schema. Do not run concurrently with another model benchmark on the same Mac.
Predictions and effective vocabulary belong in the explicitly selected local output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'packages/transcription'))
from vocabulary import run,options
from live_language import registered_identity
from vocabulary_metrics import score


def evaluate(engine,model,manifest_path,output,repeats=2):
    # Existing cache only; failed cache resolution never downloads weights.
    os.environ["HF_HUB_OFFLINE"]="1"
    os.environ["TRANSFORMERS_OFFLINE"]="1"
    import engines
    manifest=json.loads(manifest_path.read_text())
    if manifest.get('schemaVersion')!=1:raise ValueError('Unsupported fixture manifest')
    entries=manifest.get('vocabularyEntries') or [{'term':term} for term in ['Beatriz Vieira','João Pereira','Kubernetes','PostgreSQL','API','SNE']]
    snapshot={'schemaVersion':1,'libraryVersion':1,'glossaryId':'benchmark','glossaryVersion':1,'entries':entries,'additions':[]}
    asr=engines.MLXEngine(model) if engine=='mlx' else engines.CTranslate2Engine(model)
    cases=[]
    for repeat in range(repeats):
        for fixture in manifest['fixtures']:
            if fixture.get('channels',1)!=1:continue
            path=(manifest_path.parent/fixture['file']).resolve()
            if manifest_path.parent.resolve() not in path.parents:raise ValueError('Fixture path escapes manifest directory')
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            if digest!=fixture['sha256']:raise ValueError('Fixture hash mismatch')
            languages=sorted({span['language'] for span in fixture.get('spans',[])}) or ['en']
            if any(language not in ('en','pt') for language in languages):continue
            for language in languages:
                configuration=run(snapshot,engine,model,language)
                pair={}
                for enabled in (False,True):
                    # All input audio/model/decode settings are identical except initial_prompt.
                    start=time.monotonic()
                    segments,_=asr.transcribe(str(path),language=language,temperature=0.0,condition_on_previous_text=False,
                                             **(options(configuration['configuration']) if enabled else {}))
                    text=' '.join(segment.text.strip() for segment in segments)
                    seconds=time.monotonic()-start
                    gpu=None
                    if engine=='mlx':
                        import mlx.core as mx
                        gpu={'activeBytes':mx.get_active_memory(),'peakBytes':mx.get_peak_memory()}
                    pair['enabled' if enabled else 'baseline']={'metrics':score(fixture['reference'],text,[entry['term'] for entry in entries]),'seconds':seconds,'coldFirstInference':repeat==0 and len(cases)==0 and not enabled,
                        'processPeakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'mlxMemory':gpu,'prediction':text}
                cases.append({'fixture':fixture['id'],'cohort':fixture.get('cohort') or manifest.get('cohort') or 'unspecified','repeat':repeat,'language':language,'sha256':digest,'configuration':configuration,'runs':pair})
    def totals(mode,cohort=None):
        rows=[case['runs'][mode] for case in cases if cohort is None or case['cohort']==cohort];metrics=[row['metrics'] for row in rows]
        count=sum(row['spokenTerms'] for row in metrics);correct=sum(row['correctTerms'] for row in metrics)
        unrelated=[row for row in metrics if row['unrelatedSpeech']]
        return {'spokenTerms':count,'correctTerms':correct,'termRecall':correct/count if count else None,'falseInsertions':sum(row['falseInsertions'] for row in metrics),
                'unrelatedReferenceWords':sum(row['referenceWords'] for row in unrelated),'unrelatedErrors':sum(row['substitutions']+row['deletions']+row['insertions'] for row in unrelated),
                'silenceHallucinations':sum(row['silenceHallucination'] for row in metrics),'totalSeconds':sum(row['seconds'] for row in rows),
                'processPeakRssBytes':max((row['processPeakRssBytes'] for row in rows),default=0)}
    report={'schemaVersion':1,'host':platform.node(),'machine':platform.machine(),'macOS':platform.mac_ver()[0],'networkPolicy':'HF_HUB_OFFLINE=1; TRANSFORMERS_OFFLINE=1; caller may deny outbound with sandbox-exec','engine':engine,'model':model,'modelIdentity':registered_identity(engine,model),
            'manifestSha256':hashlib.sha256(manifest_path.read_bytes()).hexdigest(),'cohort':manifest.get('cohort'),'naturalVoiceEvidence':manifest.get('humanVoiceSamplesAvailable',manifest.get('humanRegionalAccentsAvailable',False)),
            'limitations':['Synthetic fixtures do not establish natural-voice accuracy or speaker accents.','Run order is baseline then enabled; timings include model warm-up and are descriptive.','Process RSS and MLX memory are distinct; process peak RSS is cumulative.','Whisper context is the first window only; model recognition is not guaranteed.'],
            'summary':{'baseline':totals('baseline'),'enabled':totals('enabled')},'summaryByCohort':{cohort:{'baseline':totals('baseline',cohort),'enabled':totals('enabled',cohort)} for cohort in sorted({case['cohort'] for case in cases})},'cases':cases}
    output.mkdir(parents=True,exist_ok=True,mode=0o700)
    report_path=output/'vocabulary-evaluation.json';report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2));os.chmod(report_path,0o600)
    print(json.dumps({'report':str(report_path),'summary':report['summary']},indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine',choices=['mlx','ctranslate2'],default='mlx');parser.add_argument('--model',default='base');parser.add_argument('--manifest',type=Path,default=ROOT/'scripts/qa/fixtures/live-languages/manifest.json');parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();evaluate(args.engine,args.model,args.manifest.resolve(),args.output.resolve())
