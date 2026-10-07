import {LocalVocabulary} from './vocabulary';
/** Router authorization remains with the loopback API entrypoint. */
export async function vocabularyHttp(req:Request,store:LocalVocabulary):Promise<Response>{
 try{const url=new URL(req.url);if(req.method==='GET'){if(url.pathname.endsWith('/export'))return new Response(store.export(),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="heed-vocabulary.json"'}});if(url.searchParams.has('search'))return Response.json({entries:store.search(url.searchParams.get('search')!)});return Response.json(store.read());}
  if(req.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});const text=await req.text();if(Buffer.byteLength(text)>1_000_000)throw Error('Vocabulary request exceeds its size limit');const body=JSON.parse(text);
  if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Invalid vocabulary request');
  if(url.pathname.endsWith('/snapshot'))return Response.json(store.snapshot(body));
  if(Object.keys(body).some(key=>!['library','expectedVersion','importText'].includes(key))||(('library' in body)===('importText' in body)))throw Error('Invalid vocabulary write');
  return Response.json('importText' in body?store.import(body.importText,body.expectedVersion):store.save(body.library,body.expectedVersion));
 }catch(error){const message=(error as Error).message;return Response.json({error:message},{status:message.includes('changed')?409:400});}
}
