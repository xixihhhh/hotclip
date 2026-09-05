#!/usr/bin/env python3
"""Optional local Qwen speech service. Run in a dedicated qwen-asr environment.
No installer, cloud API or dependency changes are performed by HotClip.
"""
import argparse
import base64
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

LANGUAGES = {"zh": "Chinese", "en": "English", "yue": "Cantonese", "fr": "French", "de": "German", "it": "Italian", "ja": "Japanese", "ko": "Korean", "pt": "Portuguese", "ru": "Russian", "es": "Spanish"}
ALIGN_LANGUAGES = set(LANGUAGES.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["0.6B", "1.7B"], default="0.6B")
    parser.add_argument("--device", choices=["cpu", "mps", "cuda:0"], default="cpu")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--aligner", action="store_true", help="Load the optional 0.6B forced aligner")
    args = parser.parse_args()
    import numpy as np
    import torch
    from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner
    model_id = "Qwen/Qwen3-ASR-" + args.model
    dtype = torch.float32 if args.device in ("cpu", "mps") else torch.bfloat16
    model = Qwen3ASRModel.from_pretrained(model_id, dtype=dtype, device_map=args.device, max_inference_batch_size=1, max_new_tokens=1024)
    aligner = Qwen3ForcedAligner.from_pretrained("Qwen/Qwen3-ForcedAligner-0.6B", dtype=dtype, device_map=args.device) if args.aligner else None
    # Include resolved model configuration in checkpoint identity.
    revision = hashlib.sha256((str(getattr(model, "model", model).config) + str(dtype) + str(aligner is not None)).encode()).hexdigest()

    inference_lock = Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Media/transcript content never goes into HTTP logs.

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"error": "unknown-route"})
            self.reply(200, {"protocol": "hotclip-speech-v1", "model": model_id, "aligner": aligner is not None, "device": args.device, "revision": revision})

        def do_POST(self):
            # Reject browser-origin requests; this is a loopback desktop protocol.
            if self.headers.get("Origin") or self.headers.get("Content-Type") != "application/json":
                return self.reply(403, {"error": "desktop-client-required"})
            if self.path not in ("/transcribe", "/align"):
                return self.reply(404, {"error": "unknown-route"})
            try:
                self.connection.settimeout(30)
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 28_000_000:
                    raise ValueError("request-size")
                raw_body = self.rfile.read(length)
                if len(raw_body) != length:
                    raise ValueError("incomplete-request")
            except (ValueError, OSError):
                return self.reply(400, {"error": "invalid-request"})
            # Consume the bounded body before rejecting a busy request so clients
            # receive the JSON status instead of a broken pipe while uploading.
            if not inference_lock.acquire(blocking=False):
                return self.reply(503, {"error": "inference-busy"})
            try:
                body = json.loads(raw_body)
                if body.get("sampleRate") != 16000:
                    raise ValueError("sample-rate")
                pcm = np.frombuffer(base64.b64decode(body["pcm"], validate=True), dtype="<f4").copy()
                if not 0 < pcm.size <= 300 * 16000 or not np.isfinite(pcm).all():
                    raise ValueError("invalid-audio")
                language = body.get("language")
                language = None if language in (None, "auto", "") else LANGUAGES.get(language, language)
                if self.path == "/align":
                    if aligner is None:
                        return self.reply(409, {"error": "aligner-not-loaded"})
                    if language not in ALIGN_LANGUAGES or not isinstance(body.get("text"), str) or not 0 < len(body["text"]) <= 8000:
                        raise ValueError("alignment-language-or-text")
                    stamps = aligner.align(audio=(pcm, 16000), text=body["text"], language=language)[0]
                    return self.reply(200, {"words": [{"text": w.text, "start": float(w.start_time), "end": float(w.end_time)} for w in stamps]})
                result = model.transcribe(audio=(pcm, 16000), language=language)[0]
                response = {"text": result.text, "language": result.language}
                if aligner and result.text.strip() and result.language in ALIGN_LANGUAGES:
                    stamps = aligner.align(audio=(pcm, 16000), text=result.text, language=result.language)[0]
                    response["words"] = [{"text": w.text, "start": float(w.start_time), "end": float(w.end_time)} for w in stamps]
                self.reply(200, response)
            except (ValueError, KeyError, TypeError):
                self.reply(400, {"error": "invalid-request"})
            except Exception as error:
                # Type only: no local paths, audio or transcript in error responses.
                print("Speech inference failed:", type(error).__name__, flush=True)
                self.reply(500, {"error": "inference-failed"})
            finally:
                inference_lock.release()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.timeout = 1
    print(f"HotClip speech service ready: {model_id} on 127.0.0.1:{args.port} ({args.device})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
