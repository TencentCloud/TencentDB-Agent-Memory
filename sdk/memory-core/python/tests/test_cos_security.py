"""COS helpers against two real HTTPS origins; credentials are synthetic."""
import asyncio
import json
import logging
import unittest
from unittest.mock import PropertyMock, patch

import httpx
from tencentdb_agent_memory import cos
import test_redirect_security as fixture

CREDENTIAL = {"CosUrl": "https://synthetic.cos.test.myqcloud.com", "TmpSecretId": "synthetic-id",
              "TmpSecretKey": "synthetic-key", "TmpToken": "synthetic-token", "PathPrefix": "private-prefix"}


class CosSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.RedirectSecurityTest.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        fixture.RedirectSecurityTest.tearDownClass.__func__(cls)

    def exercise(self, asynchronous, sts, status, retry=False, check_logs=False):
        cls = type(self)
        cls.status = [403, status] if retry else status
        cls.response = CREDENTIAL if sts else {"content": "private-response-canary"}
        self.hits.clear()
        self.origin_hits.clear()
        kwargs = dict(verify=self.ca, trust_env=False, timeout=2, follow_redirects=True)
        credential = cos.StsCredential(CREDENTIAL)
        class Manager:
            def get_credential(self): return credential
            def invalidate(self): pass
        class AsyncManager:
            async def get_credential(self): return credential
            def invalidate(self): pass
        async def async_run():
            async with httpx.AsyncClient(**kwargs) as client:
                if sts:
                    manager = cos.AsyncStsCredentialManager(self.endpoint, "synthetic-bearer", "synthetic")
                    manager._client = client
                    call = manager.get_credential()
                else:
                    reader = cos.AsyncMemoryFileReader(AsyncManager(), client=client)
                    call = reader.read("private-path-canary.md")
                if status == 200:
                    result = await call
                    self.assertEqual(result.tmp_secret_id, "synthetic-id") if sts else self.assertEqual(json.loads(result), cls.response)
                else:
                    with self.assertRaises((httpx.HTTPStatusError, cos.TDAMError)):
                        await call
        def sync_run():
            with httpx.Client(**kwargs) as client:
                if sts:
                    manager = cos.StsCredentialManager(self.endpoint, "synthetic-bearer", "synthetic")
                    manager._client = client
                    call = manager.get_credential
                else:
                    reader = cos.MemoryFileReader(Manager(), client=client)
                    call = lambda: reader.read("private-path-canary.md")
                if status == 200:
                    result = call()
                    self.assertEqual(result.tmp_secret_id, "synthetic-id") if sts else self.assertEqual(json.loads(result), cls.response)
                else:
                    with self.assertRaises((httpx.HTTPStatusError, cos.TDAMError)):
                        call()
        with patch.object(cos.StsCredential, 'cos_host', new_callable=PropertyMock, return_value=self.endpoint.removeprefix('https://')):
            with self.assertLogs(cos.logger, logging.DEBUG) as logs:
                asyncio.run(async_run()) if asynchronous else sync_run()
            if check_logs:
                for marker in ('private-path-canary', 'private-prefix', 'synthetic-token', 'synthetic-key', 'private-response-canary'):
                    self.assertNotIn(marker, str(logs.output))
        self.assertEqual(len(self.origin_hits), 2 if retry else 1)
        self.assertEqual(self.hits, [], 'COS redirects must not forward token, signature or private path')


for asynchronous in (False, True):
    for sts in (False, True):
        for status in (200, 301, 302, 303, 307, 308):
            def test(self, asynchronous=asynchronous, sts=sts, status=status):
                self.exercise(asynchronous, sts, status)
            setattr(CosSecurityTest, f'test_{"async" if asynchronous else "sync"}_{"sts" if sts else "read"}_{status}', test)
    def retry_test(self, asynchronous=asynchronous):
        self.exercise(asynchronous, False, 307, retry=True)
    setattr(CosSecurityTest, f'test_retry_redirect_{asynchronous}', retry_test)
    def privacy_test(self, asynchronous=asynchronous):
        self.exercise(asynchronous, True, 200, check_logs=True)
        self.exercise(asynchronous, False, 200, check_logs=True)
    setattr(CosSecurityTest, f'test_log_privacy_{asynchronous}', privacy_test)
