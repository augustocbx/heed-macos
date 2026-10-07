import unittest
from media_import import stream_final_import

class MediaImportTests(unittest.TestCase):
    def test_pipeline_reports_real_stages_and_the_authoritative_result(self):
        events=[]
        def finalize(path, **options):
            self.assertEqual(path, '/managed/import.wav')
            self.assertFalse(options['is_dual'])
            self.assertEqual(options['final_model'], 'base')
            options['on_phase']('diarization')
            options['on_phase']('transcription')
            return {'finalized':True,'duration':4,'language':'en','model':'base','turns':[]}
        stream_final_import(lambda event,data:events.append((event,data)), finalize, {'wav_path':'/managed/import.wav','work_directory':'/managed/staging','language':'en','final_model':'base','manual':True})
        self.assertEqual([event for event,data in events], ['phase','phase','result'])
        self.assertEqual(events[-1][1]['duration'],4)
    def test_failure_never_emits_a_successful_result(self):
        events=[]
        def fail(*args, **kwargs): raise ValueError('Synthetic processing failure')
        stream_final_import(lambda event,data:events.append((event,data)),fail,{'wav_path':'/managed/import.wav'})
        self.assertEqual(events,[('error',{'message':'Synthetic processing failure'})])


class ImportOwnershipTests(unittest.TestCase):
    def test_retry_reattaches_to_existing_job_without_second_pipeline(self):
        from media_import import ImportJobs
        owner=ImportJobs()
        calls=[]
        def finalize(*args,**options):
            calls.append(args[0])
            return {'finalized':True,'duration':4,'turns':[]}
        body={'job_id':'11111111-1111-4111-8111-111111111111','wav_path':'/managed/import.wav'}
        first=[];second=[]
        owner.stream(lambda event,data:first.append((event,data)),finalize,body)
        owner.stream(lambda event,data:second.append((event,data)),finalize,body)
        self.assertEqual(calls,['/managed/import.wav'])
        self.assertEqual(first[-1],second[-1])
    def test_disconnected_owner_retains_its_result_for_reattachment(self):
        from media_import import ImportJobs
        owner=ImportJobs();calls=[]
        def broken(event,data): raise BrokenPipeError()
        def finalize(*args,**options):
            calls.append(1);options['on_phase']('transcription')
            return {'finalized':True,'duration':4,'turns':[]}
        body={'job_id':'22222222-2222-4222-8222-222222222222','wav_path':'/managed/import.wav'}
        owner.stream(broken,finalize,body)
        result=[];owner.stream(lambda event,data:result.append((event,data)),finalize,body)
        self.assertEqual(calls,[1]);self.assertEqual(result[-1][0],'result')

    def test_active_job_reattachment_does_not_start_a_second_pipeline(self):
        import threading
        from media_import import ImportJobs
        owner=ImportJobs();entered=threading.Event();release=threading.Event();calls=[]
        def finalize(*args,**options):
            calls.append(1);entered.set();release.wait(2)
            return {'finalized':True,'duration':4,'turns':[]}
        body={'job_id':'33333333-3333-4333-8333-333333333333','wav_path':'/managed/import.wav'}
        first=threading.Thread(target=owner.stream,args=(lambda *args:None,finalize,body))
        second_result=[]
        second=threading.Thread(target=owner.stream,args=(lambda event,data:second_result.append((event,data)),finalize,body))
        first.start();self.assertTrue(entered.wait(1));second.start();release.set();first.join(2);second.join(2)
        self.assertFalse(first.is_alive());self.assertFalse(second.is_alive());self.assertEqual(calls,[1]);self.assertEqual(second_result[-1][0],'result')

    def test_different_active_import_is_blocked_without_allocating_a_pipeline(self):
        import threading
        from media_import import ImportJobs
        owner=ImportJobs();entered=threading.Event();release=threading.Event();calls=[]
        def finalize(*args,**options):
            calls.append(1);entered.set();release.wait(2)
            return {'finalized':True,'duration':4,'turns':[]}
        body={'job_id':'44444444-4444-4444-8444-444444444444','wav_path':'/managed/import.wav'}
        thread=threading.Thread(target=owner.stream,args=(lambda *args:None,finalize,body));thread.start();self.assertTrue(entered.wait(1))
        events=[]
        try:
            owner.stream(lambda event,data:events.append((event,data)),finalize,{**body,'job_id':'55555555-5555-4555-8555-555555555555'})
            self.assertEqual(events[-1][0],'error');self.assertEqual(calls,[1])
        finally:
            release.set();thread.join(2)

if __name__=='__main__':unittest.main()
