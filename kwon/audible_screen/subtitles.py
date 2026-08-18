from __future__ import annotations

from pathlib import Path


def format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def render_srt(entries: list[dict]) -> str:
    blocks: list[str] = []
    ordered = sorted(entries, key=lambda item: (float(item["start"]), float(item["end"])))
    for item in ordered:
        text = str(item.get("text", "")).strip()
        start = float(item["start"])
        end = float(item["end"])
        if not text or end <= start:
            continue
        blocks.append(
            f"{len(blocks) + 1}\n"
            f"{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}\n"
            f"{text}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def write_srt(path: Path, entries: list[dict]) -> None:
    path.write_text(render_srt(entries), encoding="utf-8-sig")


def speech_subtitle_entries(transcript: list[dict]) -> list[dict]:
    return [
        {
            "start": float(item["start"]),
            "end": float(item["end"]),
            "text": str(item.get("text", "")).strip(),
            "kind": "dialogue",
        }
        for item in transcript
        if str(item.get("text", "")).strip()
    ]


def accessible_subtitle_entries(
    transcript: list[dict], narration_results: list[dict]
) -> list[dict]:
    entries = speech_subtitle_entries(transcript)
    entries.extend(
        {
            "start": float(item["start"]),
            "end": float(item["end"]),
            "text": f"[화면해설] {str(item['narration']).strip()}",
            "kind": "audio_description",
        }
        for item in narration_results
        if str(item.get("narration", "")).strip()
    )
    return sorted(entries, key=lambda item: (item["start"], item["end"]))
