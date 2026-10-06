import {lstatSync,opendirSync} from 'node:fs';
import {join} from 'node:path';
import {CLOUD_CONNECTIONS_ENABLED} from '@heed/shared';

/** Inspect existence only, without parsing private state or constructing credential/provider clients. */
function hasState(path:string):boolean {
 try {
  const info=lstatSync(path);
  if(!info.isDirectory())return true;
  const directory=opendirSync(path);
  try {let entry;while((entry=directory.readSync()))if(entry.name!=='.DS_Store')return true;return false;}
  finally {directory.closeSync();}
 }catch(error){return (error as NodeJS.ErrnoException).code!=='ENOENT';}
}

/** Unknown preserved cloud state cannot authorize eviction of its sole pending source. */
export function disabledCloudProtectedPaths(appDir:string,libraryDir:string,mediaRoots:string[]):string[] {
 const google=!CLOUD_CONNECTIONS_ENABLED.googleDrive&&(hasState(join(appDir,'google-drive.json'))||hasState(join(libraryDir,'catalog','google-drive')));
 const microsoft=!CLOUD_CONNECTIONS_ENABLED.oneDrive&&(hasState(join(appDir,'onedrive-account.json'))||hasState(join(libraryDir,'catalog','onedrive')));
 return google||microsoft?mediaRoots:[];
}
