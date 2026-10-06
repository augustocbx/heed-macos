import {openSync,readSync,closeSync,fstatSync} from 'node:fs';
/** Channel processing produces mono 16 kHz PCM16 copies. This gate bounds each copy by its source. */
export function validateProcessingWave(path:string):void{
 const descriptor=openSync(path,'r');
 try{
  const size=fstatSync(descriptor).size,header=Buffer.alloc(Math.min(size,1_048_576));readSync(descriptor,header,0,header.length,0);
  if(header.length<12 || !['RIFF','RF64'].includes(header.toString('ascii',0,4)) || header.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid WAV; preserve the source and import a supported audio file.');
  let format=false,data=false,largeData:number|undefined;
  for(let offset=12;offset+8<=header.length;){const type=header.toString('ascii',offset,offset+4),length=header.readUInt32LE(offset+4),start=offset+8;
   if(type==='ds64' && length>=28 && start+28<=header.length){const bytes=header.readBigUInt64LE(start+8);if(bytes>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Unsupported WAV size');largeData=Number(bytes);}
   if(type==='fmt '){if(length<16 || start+length>header.length)throw new Error('Unsupported WAV header');let codec=header.readUInt16LE(start);const channels=header.readUInt16LE(start+2),rate=header.readUInt32LE(start+4),bits=header.readUInt16LE(start+14),alignment=header.readUInt16LE(start+12);if(codec===65534 && length>=40)codec=header.readUInt16LE(start+24);
    if(![1,3].includes(codec)||![1,2].includes(channels)||rate<16000||![16,24,32,64].includes(bits)||alignment!==channels*bits/8)throw new Error('Recovery WAV working copies exceed the supported source budget. Import this file to normalize it within the configured quota.');format=true;
   }
   if(type==='data'){const bytes=length===0xffffffff?largeData:length;if(bytes===undefined||start+bytes>size)throw new Error('Truncated WAV; preserve the source for recovery');data=true;break;}
   offset=start+length+(length%2);
  }
  if(!format||!data)throw new Error('Unsupported WAV header; import the source to normalize it within the configured quota.');
 }finally{closeSync(descriptor);}
}
