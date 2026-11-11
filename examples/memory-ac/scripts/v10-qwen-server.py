"""Single-request local Qwen scorer. The owning Node runtime kills it on timeout."""
import hashlib
import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import torch
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer

model_path = Path('runtime/models/qwen3-reranker-06b-v9')
manifest = json.loads((model_path / 'manifest.json').read_text(encoding='utf8'))
assert manifest['revision'] == 'e61197ed45024b0ed8a2d74b80b4d909f1255473'
assert torch.__version__ == '2.11.0+cu128' and transformers.__version__ == '5.5.4'
assert torch.cuda.is_available()
for source in manifest['sources']:
    path = model_path / source['path']
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while data := stream.read(4 * 1024 * 1024):
            digest.update(data)
    assert digest.hexdigest() == source['sha256']
torch.set_num_threads(6)
torch.manual_seed(20260914)
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False
tokenizer = AutoTokenizer.from_pretrained(model_path, padding_side='left', local_files_only=True)
model = AutoModelForCausalLM.from_pretrained(model_path, dtype=torch.bfloat16,
    attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
suffix = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
instruction = 'Given a question about past conversations, retrieve passages containing evidence needed to answer it, respecting the speaker and date.'
no_id, yes_id = tokenizer.convert_tokens_to_ids('no'), tokenizer.convert_tokens_to_ids('yes')

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def respond(self, status, value):
        body = json.dumps(value).encode('utf8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/health':
            return self.respond(404, {'error': 'unknown_route'})
        self.respond(200, {'ready': True, 'revision': manifest['revision'], 'pid': os.getpid(),
            'dtype': 'bfloat16', 'batch': 2, 'single_request': True})

    def do_POST(self):
        if self.path != '/score':
            return self.respond(404, {'error': 'unknown_route'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            assert 0 < length <= 2_000_000
            r = json.loads(self.rfile.read(length))
            assert set(r) <= {'query', 'items', 'fault'}
            if r.get('fault'):
                assert os.environ.get('V10_TEST_FAULTS') == '1' and r['fault'] == 'hang'
                while True:
                    time.sleep(1)
            query, items = r['query'], r['items']
            assert isinstance(query, str) and len(query) <= 20000 and len(items) <= 64
            assert len({x['id'] for x in items}) == len(items)
            assert all(isinstance(x['content'], str) and len(x['content']) <= 20000 for x in items)
            start = time.perf_counter()
            scores, lengths = [], []
            for offset in range(0, len(items), 2):
                docs = [f"[Date: {x.get('date')}][Role: {x.get('role')}]\n{x['content']}" for x in items[offset:offset+2]]
                strings = [prefix + f'<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {doc}' + suffix for doc in docs]
                tokens = tokenizer(strings, padding=True, return_tensors='pt', add_special_tokens=False, truncation=False)
                assert tokens.input_ids.shape[1] <= 8192
                lengths.extend(tokens.attention_mask.sum(-1).tolist())
                with torch.inference_mode():
                    logits = model(**tokens.to('cuda'), logits_to_keep=1).logits[:, -1, :]
                    scores.extend((logits[:, yes_id].float() - logits[:, no_id].float()).tolist())
                del logits, tokens
            torch.cuda.synchronize()
            self.respond(200, {'scores': [{'id': x['id'], 'score': s} for x, s in zip(items, scores)],
                'elapsed_ms': (time.perf_counter() - start) * 1000, 'input_tokens': sum(lengths),
                'revision': manifest['revision'], 'peak_allocated_bytes': torch.cuda.max_memory_allocated()})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(json.dumps({'event': 'request_rejected', 'error_type': type(error).__name__}), flush=True)
            self.respond(400, {'error': 'scoring_rejected'})

    def log_message(self, format, *args):
        pass

print(json.dumps({'event': 'ready', 'pid': os.getpid(), 'port': 18431}), flush=True)
HTTPServer(('127.0.0.1', 18431), Handler).serve_forever()
