# Voice Bridge v1 data directory

The `/v1` API serves only pre-registered, preprocessed media. It never fetches
an arbitrary URL supplied by a browser extension.

## Layout

```text
data/
  catalog.json
  manifests/<provider>/<video_id>.json
  audio/<sha256>.wav
  jobs/<job_id>.json
  examples/manifest.v1.json
```

- `catalog.json` is the allowlist. A job can be created only for an enabled
  `provider` + `video_id` entry. You can still edit it by hand, but you don't
  have to: `pipeline/build_manifest.py` and `POST /dev/process` both
  auto-register a video here (measuring its real duration first) the first
  time they see an unfamiliar `video_id`, then process it immediately — see
  `../README.md` section 3. `/v1` itself never writes to this file; it only
  reads it.
- A pipeline worker publishes clips under `audio/` and then atomically moves a
  complete manifest into `manifests/`. Do not expose a partially written
  manifest. `core.storage.FileRepository.publish_audio()` /
  `publish_manifest()` do this correctly (validate-then-atomic-write); avoid
  writing directly into `manifests/` from a script.
- Clip filenames are the lowercase SHA-256 of their exact bytes. The manifest
  path must be `/v1/audio/<sha256>.wav`.
- The server creates `jobs/*.json` at runtime. These files are intentionally
  ignored by Git.
- `examples/manifest.v1.json` is documentation only. It is not served because
  it is outside `manifests/` and its placeholder audio file does not exist.

Public times are integer milliseconds. A playable manifest is rejected as a
whole when segments are unsorted or overlap, a clip is longer than its gap, a
path and hash disagree, or the actual WAV bytes/format/duration do not match
the declaration. WAV assets must be PCM 16-bit, mono, and use the sample rate
declared by `voice.sample_rate_hz`.

Set `VOICE_BRIDGE_DATA_DIR` to use another root. Relative values are resolved
from the backend directory, not from the process working directory.

