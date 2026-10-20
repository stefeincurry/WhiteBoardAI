# Piper TTS worker: loads the voice ONCE, then turns lines of text into WAV audio.
# Started by tts/piper.js. One JSON object per line:
#   stdin:  {"id": 1, "text": "Hello there"}
#   stdout: {"id": 1, "wav": "<base64 WAV>", "durationMs": 1234, "synthMs": 210}
#       or  {"id": 1, "error": "..."}
# The first line printed is {"ready": true, "loadMs": ...} once the voice is loaded and warmed up.
#
#   python piper_worker.py <voice.onnx> [length_scale]    (length_scale > 1 = slower speech)

import base64
import io
import json
import sys
import time
import wave

from piper import PiperVoice, SynthesisConfig


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def synth(voice, text, cfg):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf, syn_config=cfg)
        frames, rate = wf.getnframes(), wf.getframerate()
    return buf.getvalue(), round(1000 * frames / rate)


def main():
    t0 = time.time()
    voice = PiperVoice.load(sys.argv[1])
    cfg = SynthesisConfig(length_scale=float(sys.argv[2]) if len(sys.argv) > 2 else None)
    synth(voice, "Ready.", cfg)  # warm-up, so the first real line isn't slow
    emit({"ready": True, "loadMs": round(1000 * (time.time() - t0))})

    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            t = time.time()
            wav, duration_ms = synth(voice, req["text"], cfg)
            emit({
                "id": req["id"],
                "wav": base64.b64encode(wav).decode("ascii"),
                "durationMs": duration_ms,
                "synthMs": round(1000 * (time.time() - t)),
            })
        except Exception as e:  # keep the worker alive; report the error for this line
            emit({"id": req.get("id"), "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
