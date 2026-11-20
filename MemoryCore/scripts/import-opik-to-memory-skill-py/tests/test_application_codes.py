"""Actual HTTP v3 status-code classification; no production services."""
import unittest
from test_log_privacy import module, server, Logs

class ApplicationCodeTests(unittest.TestCase):
    def client(self, url):
        return module.MemoryCoreClient(url, 'synthetic-key', 'synthetic-service', 'synthetic-team', 'synthetic-agent', 'synthetic-user', retries=0)

    def test_invalid_codes_are_not_acknowledgments(self):
        for code in [False, True, '0', None, 'missing']:
            response={'code':code,'message':'synthetic rejection','data':{'status':'archived'}}
            if code=='missing':response.pop('code')
            with self.subTest(code=code), server(response=response) as url:
                core=self.client(url)
                for operation in [lambda:core.conversation_add('synthetic-session',[]),lambda:core.force_archive('synthetic-session')]:
                    with self.assertRaises(RuntimeError):operation()

    def test_invalid_boolean_reply_counts_import_and_archive_failures(self):
        with server(response={'code':False,'data':{'status':'archived'}}) as url:
            session=module.Session('synthetic-session','synthetic-thread','synthetic-trace',1,[{'role':'user','content':'synthetic message'}])
            stats=module.import_session(session,self.client(url),turn_gap_s=0,force_archive=True,dry_run=False,logger=Logs())
            self.assertEqual(stats,{'turns':1,'archived':0,'force_archived':0,'errors':2})

    def test_integer_zero_preserves_success_data(self):
        data={'status':'archived','synthetic':'preserved'}
        with server(response={'code':0,'data':data}) as url:
            self.assertEqual(self.client(url).conversation_add('synthetic-session',[]),data)

    def test_float_zero_preserves_numeric_contract(self):
        with server(response={'code':0.0,'data':{'status':'archived'}}) as url:
            self.assertEqual(self.client(url).force_archive('synthetic-session'),{'status':'archived'})

if __name__=='__main__':unittest.main()
