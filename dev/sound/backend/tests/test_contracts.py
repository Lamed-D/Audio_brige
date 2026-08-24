from __future__ import annotations

from copy import deepcopy

import pytest

from core.contracts import ContractValidationError, validate_manifest


def test_valid_manifest_is_accepted(repository, publish):
    manifest, _, _ = publish()
    assert validate_manifest(
        manifest,
        expected_provider="youtube",
        expected_video_id="abc123",
        expected_duration_ms=20_000,
    ) is manifest
    assert repository.find_manifest("youtube", "abc123") is not None


@pytest.mark.parametrize(
    ("mutate", "expected_field"),
    [
        (
            lambda manifest: manifest["segments"][0].update(deadline_ms=900),
            "segments[0].deadline_ms",
        ),
        (
            lambda manifest: manifest["segments"][0]["audio"].update(duration_ms=501),
            "segments[0].audio.duration_ms",
        ),
        (
            lambda manifest: manifest["segments"][0]["audio"].update(
                path="/v1/audio/" + "f" * 64 + ".wav"
            ),
            "segments[0].audio.path",
        ),
        (
            lambda manifest: manifest["segments"][0].update(confidence="low"),
            "segments[0].confidence",
        ),
        (
            lambda manifest: manifest["video"].update(duration_ms=20_000.0),
            "video.duration_ms",
        ),
    ],
)
def test_manifest_contract_rejects_unsafe_values(publish, mutate, expected_field):
    manifest, _, _ = publish()
    changed = deepcopy(manifest)
    mutate(changed)
    with pytest.raises(ContractValidationError, match=expected_field.replace("[", r"\[").replace("]", r"\]")):
        validate_manifest(changed)


def test_manifest_contract_rejects_overlap(publish):
    manifest, _, _ = publish()
    changed = deepcopy(manifest)
    second = deepcopy(changed["segments"][0])
    second["id"] = "seg-002"
    second["trigger_ms"] = 1_400
    second["deadline_ms"] = 1_900
    changed["segments"].append(second)
    with pytest.raises(ContractValidationError, match="겹칩니다"):
        validate_manifest(changed)


def test_manifest_contract_rejects_extended_without_high_importance(publish):
    manifest, _, _ = publish()
    changed = deepcopy(manifest)
    changed["segments"][0].pop("deadline_ms")
    changed["segments"][0]["mode"] = "extended"
    with pytest.raises(ContractValidationError, match="importance"):
        validate_manifest(changed)


def test_manifest_contract_rejects_close_extended_segments(publish):
    manifest, _, _ = publish()
    changed = deepcopy(manifest)
    changed["segments"][0].pop("deadline_ms")
    changed["segments"][0]["mode"] = "extended"
    changed["segments"][0]["importance"] = "high"

    second = deepcopy(changed["segments"][0])
    second["id"] = "seg-002"
    second["trigger_ms"] = changed["segments"][0]["trigger_ms"] + 5_000
    changed["segments"].append(second)
    with pytest.raises(ContractValidationError, match="extended 간격"):
        validate_manifest(changed)

