# jarvis/server.py — 자비스의 "입". 엣지의 신경망 음성(edge-tts)을 무료로 쓴다.
#
#   pip install edge-tts
#   python jarvis/server.py        →  브라우저가 http://localhost:3939 로 열린다
#
# 브라우저 기본 음성은 컴퓨터마다 다르고 크롬엔 한국어 남성 음성이 없다.
# edge-tts 는 마이크로소프트 엣지의 읽어주기 엔진을 키·계정 없이 쓰는 라이브러리라
# 어느 브라우저에서 열어도 같은 자연스러운 남성 목소리(InJoon)가 나온다.
# 듣기(음성 인식)와 두뇌(Groq)는 그대로 브라우저가 한다. 이 서버는 목소리만 만든다.

import asyncio
import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import edge_tts
except ImportError:
    sys.exit("edge-tts 가 없습니다. 먼저 실행하세요:  pip install edge-tts")

HOST = "127.0.0.1"
PORT = int(os.environ.get("JARVIS_PORT", "3939"))
PAGE = Path(__file__).with_name("jarvis.html")

# 고를 수 있는 한국어 신경망 음성. 첫 번째가 기본값
VOICES = [
    {"id": "ko-KR-InJoonNeural", "label": "♂ 인준 (차분한 남성)"},
    {"id": "ko-KR-HyunsuMultilingualNeural", "label": "♂ 현수 (부드러운 남성)"},
    {"id": "ko-KR-SunHiNeural", "label": "선히 (여성)"},
]
ALLOWED = {v["id"] for v in VOICES}


async def synthesize(text, voice, rate):
    audio = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    return bytes(audio)


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html", "/jarvis.html"):
            return self.send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
        if self.path == "/tts/voices":
            return self.send(200, VOICES)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/tts":
            return self.send(404, {"error": "not found"})
        # 다른 사이트가 열린 탭을 통해 이 서버를 부르지 못하게 한다
        origin = self.headers.get("Origin")
        if origin and origin not in (f"http://localhost:{PORT}", f"http://{HOST}:{PORT}"):
            return self.send(403, {"error": "허용되지 않은 출처"})
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 20_000)
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text", "")).strip()[:3000]
            voice = req.get("voice") if req.get("voice") in ALLOWED else VOICES[0]["id"]
            if not text:
                return self.send(400, {"error": "읽을 글이 없음"})
            audio = asyncio.run(synthesize(text, voice, "-5%"))
            self.send(200, audio, "audio/mpeg")
        except Exception as e:
            print("[jarvis] 음성 생성 실패:", e)
            self.send(500, {"error": str(e)})

    def log_message(self, *args):
        pass  # 요청마다 찍히는 로그는 끈다


if __name__ == "__main__":
    url = f"http://localhost:{PORT}"
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"\n  J.A.R.V.I.S. 온라인 → {url}   (끄려면 Ctrl+C)\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
