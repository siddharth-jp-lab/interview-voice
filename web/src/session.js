const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export function prepareCall() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("The microphone needs a secure page");
  }
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  const audioCtx = new AudioContext();
  const resume = audioCtx.resume();
  const micPromise = navigator.mediaDevices.getUserMedia({ audio: true });
  audio.play().catch(() => {});
  let released = false;
  return {
    audio,
    audioCtx,
    resume,
    micPromise,
    async cancel() {
      if (released) return;
      released = true;
      try {
        const mic = await micPromise;
        for (const track of mic.getTracks()) track.stop();
      } catch {
        // The prompt was denied, or it is still open.
      }
      audio.srcObject = null;
      await audioCtx.close().catch(() => {});
    },
  };
}

export async function startSession({ sessionId, history = [], onEvent, onLevel, media }) {
  const tokenResponse = await fetch(`/token?session=${encodeURIComponent(sessionId)}`);
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(tokenPayload.error || "Could not start a session");
  }

  const pc = new RTCPeerConnection();
  const { audio, audioCtx } = media;
  const micAnalyser = audioCtx.createAnalyser();
  const playAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 256;
  playAnalyser.fftSize = 256;
  let drive = "quiet";
  let raf = 0;
  let handedOff = false;

  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    const playback = audioCtx.createMediaStreamSource(event.streams[0]);
    playback.connect(playAnalyser);
    audio.play().catch(() => {});
  };

  try {
    const mic = await media.micPromise;
    await media.resume;
    const micSource = audioCtx.createMediaStreamSource(mic);
    micSource.connect(micAnalyser);
    for (const trackStream of mic.getTracks()) pc.addTrack(trackStream, mic);

    const samples = new Uint8Array(micAnalyser.fftSize);
    const pump = () => {
      const analyser = drive === "assistant" ? playAnalyser : micAnalyser;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      if (drive !== "quiet") {
        for (const value of samples) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
      }
      onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 8));
      raf = requestAnimationFrame(pump);
    };
    await audioCtx.resume();
    pump();

    const dc = pc.createDataChannel("oai-events");
    dc.addEventListener("message", (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // Ignore non-JSON events.
      }
    });

    const opened = new Promise((resolve, reject) => {
      dc.addEventListener("open", resolve, { once: true });
      dc.addEventListener("error", () => reject(new Error("Data channel failed")), { once: true });
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    const sdpResponse = await fetch(CALLS_URL, {
      method: "POST",
      body: pc.localDescription.sdp,
      headers: {
        Authorization: `Bearer ${tokenPayload.value}`,
        "Content-Type": "application/sdp",
      },
    });
    const answer = await sdpResponse.text();
    if (!sdpResponse.ok) throw new Error(answer || "WebRTC connection failed");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    await opened;

    const prior = history.slice(-40);
    for (const line of prior) {
      const user = line.role === "user";
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: user ? "user" : "assistant",
          content: [{ type: user ? "input_text" : "output_text", text: line.text }],
        },
      }));
    }
    dc.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: prior.length
          ? "Continue the interview from the transcript. Do not greet again. Ask the next question."
          : "Greet the candidate in one sentence and ask the first interview question.",
      },
    }));

    handedOff = true;
    return {
      setDrive(next) {
        drive = next === "assistant" || next === "user" ? next : "quiet";
      },
      mute(muted) {
        for (const trackStream of mic.getTracks()) trackStream.enabled = !muted;
      },
      askToClose() {
        if (dc.readyState !== "open") return;
        dc.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: "The candidate is ending the interview. Give a one-sentence close and stop.",
          },
        }));
      },
      stop() {
        cancelAnimationFrame(raf);
        dc.close();
        pc.close();
        media.cancel();
      },
    };
  } finally {
    if (!handedOff) {
      cancelAnimationFrame(raf);
      pc.close();
      await media.cancel();
    }
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    }, 2500);
  });
}
