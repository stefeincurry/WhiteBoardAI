# Microsoft neural voices (edge-tts, free, needs internet) for languages whose Piper voice sounds robotic.
# Started by tts/edge.js. Lines are made at the same time, not one after another. One JSON object per line:
#   stdin:  {"id": 1, "text": "Arre bhai...", "voice": "en-IN-NeerjaNeural", "rate": "+0%"}
#   stdout: {"id": 1, "mp3": "<base64 MP3>", "synthMs": 640}   or   {"id": 1, "error": "..."}
# The first line printed is {"ready": true}.

import asyncio
import base64
import json
import sys
import time

import edge_tts


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def make(req):
    t0 = time.time()
    try:
        audio = bytearray()
        async for chunk in edge_tts.Communicate(req["text"], req["voice"], rate=req.get("rate", "+0%")).stream():
            if chunk["type"] == "audio":
                audio += chunk["data"]
        if not audio:
            raise RuntimeError("no audio came back")
        emit({"id": req["id"], "mp3": base64.b64encode(bytes(audio)).decode(), "synthMs": int((time.time() - t0) * 1000)})
    except Exception as e:
        emit({"id": req["id"], "error": f"{type(e).__name__}: {e}"})


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    emit({"ready": True})
    tasks = set()
    while line := await reader.readline():
        task = asyncio.create_task(make(json.loads(line)))
        tasks.add(task)
        task.add_done_callback(tasks.discard)


asyncio.run(main())
