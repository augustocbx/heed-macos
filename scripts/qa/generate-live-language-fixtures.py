#!/usr/bin/env python3
"""Regenerate authored synthetic eSpeak NG 1.51 fixtures (never use system voices).
Pass an existing isolated eSpeak binary/data directory. No software is installed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import wave

FIXTURES=[
 ('short-en',[('en','Ready now.',0,{'languageAnchors':['ready','now']})]),
 ('short-pt',[('pt','Bom dia.',0,{'languageAnchors':['bom','dia'],'translatedAlternatives':['Good morning']})]),
 ('names-en',[('en','Beatriz Vieira reviewed Kubernetes and PostgreSQL.',0,{'languageAnchors':['reviewed','and'],'names':['Beatriz Vieira'],'terms':['Kubernetes','PostgreSQL']})]),
 ('names-pt',[('pt','João Pereira revisou Kubernetes e PostgreSQL.',0,{'languageAnchors':['revisou'],'names':['João Pereira'],'terms':['Kubernetes','PostgreSQL']})]),
 ('alternating',[('pt','A implantação está pronta.',0,{'languageAnchors':['implantação','pronta'],'translatedAlternatives':['The deployment is ready']}),('en','Deploy the release now.',0,{'languageAnchors':['deploy','release','now'],'terms':['release']})]),
 ('within-turn',[('pt','A reunião começa agora.',0,{'languageAnchors':['reunião','agora'],'translatedAlternatives':['The meeting starts now']}),('en','Please review the pull request.',0,{'languageAnchors':['please','review'],'terms':['pull request']})]),
 ('overlap-dual',[('pt','João revisou a implantação.',0,{'languageAnchors':['revisou','implantação'],'names':['João']}),('en','Beatriz reviewed the release.',1,{'languageAnchors':['reviewed','release'],'names':['Beatriz'],'terms':['release']})]),
 ('silence',[]),
]

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--espeak',required=True);parser.add_argument('--espeak-data',required=True);parser.add_argument('--output',type=Path,default=Path(__file__).parent/'fixtures/live-languages');args=parser.parse_args()
 version=subprocess.check_output([args.espeak,'--version'],env={**os.environ,'ESPEAK_DATA_PATH':args.espeak_data},text=True)
 if '1.51 ' not in version:raise ValueError('Fixtures are pinned to eSpeak NG 1.51')
 output=args.output;output.mkdir(parents=True,exist_ok=True);records=[]
 with tempfile.TemporaryDirectory(prefix='heed-tts-render-') as temporary:
  for fixture_id,utterances in FIXTURES:
   channels=2 if fixture_id=='overlap-dual' else 1;lanes=[bytearray(b'\0'*16000) for _ in range(channels)];spans=[]
   for index,(language,text,channel,extra) in enumerate(utterances):
    voice='pt-br' if language=='pt' else 'en-us';raw=Path(temporary)/'voice.wav';converted=Path(temporary)/'voice-pcm.wav'
    subprocess.run([args.espeak,'-v',voice,'-s','145','-w',str(raw),text],check=True,env={**os.environ,'ESPEAK_DATA_PATH':args.espeak_data},capture_output=True)
    subprocess.run(['ffmpeg','-y','-loglevel','error','-i',str(raw),'-ar','16000','-ac','1','-c:a','pcm_s16le',str(converted)],check=True)
    with wave.open(str(converted)) as source:audio=source.readframes(source.getnframes())
    start=len(lanes[channel])/32000;lanes[channel].extend(audio);end=len(lanes[channel])/32000
    spans.append({'id':fixture_id+'-'+str(index),'language':language,'text':text,'start':start,'end':end,'channel':channel,'turn':0 if fixture_id=='within-turn' else index,'voice':voice,**extra})
    if fixture_id!='within-turn':lanes[channel].extend(b'\0'*8000)
   frames=max(max(len(lane)//2 for lane in lanes),32000 if fixture_id.startswith('short-') else 48000)
   for lane in lanes:lane.extend(b'\0'*(frames*2-len(lane)))
   interleaved=b''.join(lane[frame*2:frame*2+2] for frame in range(frames) for lane in lanes)
   path=output/(fixture_id+'.wav')
   with wave.open(str(path),'wb') as target:target.setparams((channels,2,16000,0,'NONE','not compressed'));target.writeframes(interleaved)
   records.append({'id':fixture_id,'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'seconds':frames/16000,'channels':channels,'cohort':'authored-formant-TTS','license':'GPL-3.0-or-later','reference':' '.join(span['text'] for span in spans),'spans':spans,'channelReferences':{str(channel):' '.join(span['text'] for span in spans if span['channel']==channel) for channel in range(channels)}})
 manifest={'schemaVersion':1,'cohort':'authored-formant-TTS','humanRegionalAccentsAvailable':False,'annotationTiming':'Synthesis window boundaries, not manually aligned word times','provenance':{'textAuthor':'Heed project authored QA fixtures','synthesizer':'eSpeak NG 1.51','source':'https://github.com/espeak-ng/espeak-ng/tree/1.51','voiceDataLicense':'GPL-3.0-or-later','audioLicense':'GPL-3.0-or-later','rateWordsPerMinute':145,'ffmpeg':'PCM16 16kHz channel-preserving conversion','sourceArchiveSha256':'f0e028f695a8241c4fa90df7a8c8c5d68dcadbdbc91e758a97e594bbb0a3bdbf','releaseArchiveSha256':'027fa5dfa8616d5cc13f883209ff5f735eee6559f7689a019d5b2d01d290cd39'},'limitations':['Synthetic formant speech does not establish natural accents, human voice quality or regional diversity.','Within-turn switching concatenates authored EN/PT synthesizer utterances; it does not simulate a natural bilingual speaker.','Overlap uses independent channels; same-channel overlapping human speech is not evaluated.'],'fixtures':records}
 (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
