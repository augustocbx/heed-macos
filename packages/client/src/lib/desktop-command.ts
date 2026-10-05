export interface DesktopCommand { id?:string; action:'start'|'stop'; language:'pt'|'en' }
export async function executeDesktopCommand(
 command:DesktopCommand,
 state:{recording:boolean;processing:boolean;ready:boolean},
 controls:{start:(language?:string)=>Promise<boolean>;stop:(language?:string)=>Promise<boolean>},
) {
 if (command.action === 'start') {
  if (!state.ready) throw new Error('Heed is still preparing transcription models. Try again when ready.');
  if (state.recording || state.processing) throw new Error('Heed is already recording or processing.');
  if (!await controls.start(command.language)) throw new Error('Recording did not start. Check microphone and system-audio permission in the interface.');
 } else {
  if (!state.recording) throw new Error('Heed is not recording.');
  if (!await controls.stop(command.language)) throw new Error('Recording could not be finalized. Check the interface and recover saved audio.');
 }
}
