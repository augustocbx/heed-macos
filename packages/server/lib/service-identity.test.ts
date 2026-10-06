import {test,expect} from 'bun:test';
import {isTranscriptionHealth} from '../../shared/lib/service-identity';
test('ready/model flags cannot impersonate Heed transcription identity',()=>{
 const health={service:'heed-transcription',protocolVersion:1,checkoutRoot:'/synthetic',pid:42,ready:false,whisper:false,pyannote:false};
 expect(isTranscriptionHealth(health)).toBe(true);
 for(const value of [null,'<html>',{ready:true,whisper:true}, {...health,service:'other'}, {...health,pid:0},{...health,protocolVersion:2},{...health,ready:1}])expect(isTranscriptionHealth(value)).toBe(false);
});
