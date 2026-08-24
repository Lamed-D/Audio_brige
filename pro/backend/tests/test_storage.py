from core.storage import FileRepository


def test_jobs_survive_repository_recreation(repository):
    video = repository.get_catalog_video("youtube", "abc123")
    assert video is not None
    created = repository.create_or_get_job(video)

    reopened = FileRepository(repository.root)
    loaded = reopened.get_job(created["job_id"])
    reused = reopened.create_or_get_job(video)

    assert loaded == created
    assert loaded["status"] == "queued"
    assert reused["job_id"] == created["job_id"]
