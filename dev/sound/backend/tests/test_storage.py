from core.storage import FileRepository


def test_jobs_survive_repository_recreation(repository):
    video = repository.get_catalog_video("youtube", "abc123")
    assert video is not None
    created, outcome = repository.create_or_get_job(video)
    assert outcome == "queued"

    reopened = FileRepository(repository.root)
    loaded = reopened.get_job(created["job_id"])

    assert loaded == created
    assert loaded["status"] == "queued"


def test_fail_job_sets_terminal_state_with_retryable(repository):
    video = repository.get_catalog_video("youtube", "abc123")
    created, _outcome = repository.create_or_get_job(video)
    repository.update_job_progress(created["job_id"], stage="audio_analysis", progress_percent=20)

    failed = repository.fail_job(
        created["job_id"], code="PIPELINE_FAILED", message="boom", retryable=True
    )

    assert failed["status"] == "failed"
    assert failed["error"] == {"code": "PIPELINE_FAILED", "message": "boom", "retryable": True}
    # 실패 직전까지의 progress_percent는 그대로 남는다 — job이 processing에
    # 멈춰 있던 게 아니라 실제로 20%까지 진행했다가 실패했음을 알 수 있다.
    assert failed["progress_percent"] == 20

    # 이미 terminal 상태인 job에 다시 진행률을 보내도 무시된다.
    untouched = repository.update_job_progress(
        created["job_id"], stage="validation", progress_percent=90
    )
    assert untouched["status"] == "failed"
